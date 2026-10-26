import { productCandidates } from './product-metadata';
import { quoteWanted } from '../consultation-policy';
import { productInquiry, usesProductInquiry } from './product-inquiry';
import { lookupProductName, productNameLookupReply } from './supplier-catalog';
import { chatAttachmentInputs } from './chat-images';
import { asksOneMissingPoint } from '../chat-policy';
import { asyncFilter, asyncMap } from '@/lib/async-arrays';
import type {
  ChatMessage,
  ChatResponse,
  ResearchAspect,
  Conversation,
  Evidence,
  Product,
  QueryIntent,
  Source,
  StoredChatMessage,
} from '../contracts';
import { audit, byId, db, getSettings, list, normalize, now, save, uid } from './db';
import {
  conversationMessages,
  publicProduct,
  publicProducts,
  requireFlag,
  verifyConversation,
} from './business';
import { classifyQuery, localIntent } from './providers';
import {
  factDetail,
  factualReply,
  handoffReply,
  missingProductReply,
  productReply,
  transactionReply,
} from './chat-replies';
import {
  CHAT_ROUTE_LABELS,
  conversationNotice,
  businessIntents,
  isBareReply,
  planChatRoute,
  policyKeys,
  socialOnly,
  stripCourtesy,
} from '../chat-policy';
import { documentCandidates } from './retrieval';
import { generateGroundedReply, groundingHash, responseModel } from './ai-responses';
import { responseBudgets } from './response-transport';
import { sourceProduct, sourcingReply } from './sourcing';
import { publicSourcing } from './sourcing-reply';
import { salesConversation, shouldUseSalesConversation } from './sales-conversation';
import { selectionReply } from './product-selection';
import {
  createSourceTrace,
  preferredSiteFor,
  finishSourceStage,
  searchRegisteredFirst,
  startSourceStage,
} from './preferred-sources';
import { sourcingEstimate, sourcingContextRevision } from './sourcing-estimate';
import { estimateReply } from '../sourcing-estimate';
import { company } from '../company';
import { destinationIn, researchForStaff, statedQuantities } from './research';
import {
  CONFIRM_PHRASE,
  availableFields,
  containsPrivateSupplierIdentity,
  itemFieldsFromText,
  knowledgeReply,
  knowledgeTopic,
  privateSupplierQuestion,
} from './supplier-knowledge';
import {
  HANDOFF_LABEL,
  QUOTE_LABEL,
  checklist,
  companyFact,
  composeConsultation,
  oneMissingPoint,
  consultationTopic,
  faqFact,
  handoffDraft,
  handoffGuide,
  policyAnswers,
  statedConditions,
  summarizeConsultation,
  topicName,
} from './consultation';

const thanksPattern = /ありがと|助か|了解|わかりました|分かりました|なるほど|どうも/;
const introduction =
  'こんにちは。アオキエンジの商品・製作相談アシスタントです。\n商品の取扱い、価格・在庫・納期の確認や、図面からの製作についてご案内します。どのようなものをお探しですか？';

export async function answerChat(
  message: string,
  owner: string,
  conversationId?: string,
  output: {
    attachmentIds?: string[];
    onText?: (text: string) => unknown;
    receipt?: { conversationId: string; userId: string; assistantId: string };
    signal?: AbortSignal;
    // Runs work after the reply is sent, such as research for the staff.
    defer?: (work: () => Promise<void>) => void;
  } = {},
): Promise<ChatResponse> {
  await requireFlag('chat');
  const userCreatedAt = now();
  const settings = await getSettings();
  const budgets = responseBudgets(settings.flags.webSearch, responseModel(settings));
  output = {
    ...output,
    signal: output.signal || AbortSignal.timeout(budgets.chat),
  };
  const received =
    output.receipt && (await byId<Conversation>('conversations', output.receipt.conversationId));
  const existingId = conversationId || received?.id;
  const conversation: Conversation = existingId
    ? await verifyConversation(existingId, owner)
    : {
        id: output.receipt?.conversationId || uid(),
        title: message.slice(0, 60),
        status: 'open',
        createdAt: userCreatedAt,
        updatedAt: now(),
      };
  const attachments = output.attachmentIds?.length ? await chatAttachmentInputs(output.attachmentIds, conversation.id, owner) : { images: [], documents: [] };
  const imageInputs = attachments.images;
  const previous = existingId
    ? (await currentMessages(conversation.id)).filter(
        (m) => m.id !== output.receipt?.userId && m.id !== output.receipt?.assistantId,
      )
    : [];
  const usageContext = {
    scope: 'chat' as const,
    conversationId: conversation.id,
    turnId: output.receipt?.userId || uid(),
  };
  // Record receipt before any external service runs. An interrupted reply must
  // not erase the customer's question or the conversation from the admin list.
  await db().transaction(async () => {
    await save('conversations', { ...conversation, updatedAt: userCreatedAt }, { owner_id: owner });
    await save(
      'messages',
      {
        id: usageContext.turnId,
        conversationId: conversation.id,
        role: 'user',
        content: message,
        attachmentIds: output.attachmentIds,
        createdAt: userCreatedAt,
      },
      { conversation_id: conversation.id },
    );
    if (!existingId)
      await audit('conversation.created', conversation.id, '商品相談を受け付けました');
  })();
  const assistantId = output.receipt?.assistantId || uid();
  const sourceTrace = await createSourceTrace();
  const onText = output.onText;
  if (onText) {
    output.onText = async (content) => {
      // Keep the latest text offered to the stream, even if delivery fails.
      // Completion replaces this same row, without duplicating the reply.
      if (content.trim())
        await save(
          'messages',
          {
            id: assistantId,
            conversationId: conversation.id,
            role: 'assistant',
            replyToId: usageContext.turnId,
            content,
            incomplete: true,
            sourceTrace,
            createdAt: now(),
          },
          { conversation_id: conversation.id },
        );
      await onText(content);
    };
  }
  if (attachments.documents.length) message += `\n\nお客様が添付した資料（未確認の参考情報）：\n${attachments.documents.join('\n\n')}\n資料内の記述はお客様の参考情報として扱い、在庫・価格・販売条件の確定根拠にはしないでください。`;
  const notice = conversationNotice(message);
  const privateQuestion = await privateSupplierQuestion(message);
  const entryTopic = await knowledgeTopic(message, localIntent(message), previous.at(-1));
  if ((!entryTopic || entryTopic.mode === 'fields') && !notice && !privateQuestion && conversation.status !== 'handed_off' && usesProductInquiry(message, previous, imageInputs)) {
    const result = await productInquiry({ message, history: previous, settings, trace: sourceTrace, context: usageContext, images: imageInputs, signal: output.signal });
    let responseReason = 'product_inquiry_local';
    if (!result.productNameLookup && !imageInputs.length && !result.inquiryState.imageCandidates?.length && !result.products?.length && !result.estimate && result.handoff !== 'quote') {
      const generated = await generateGroundedReply({
        question: message, history: previous, canonical: result.content,
        facts: [
          { id: 'current_result', text: result.content },
          { id: 'identification', text: '写真だけで必ず商品を特定できるとは限らない。写真・資料がなくても用途・形状・取付箇所などの説明から相談できる。異なる型番の在庫や納期は転用できない。' },
          { id: 'contact', text: '未確認事項はお問い合わせフォームから担当者へ相談できる。送信操作前は受付・社内確認は実行されていない。見積は顧客が希望した場合のみ。' },
        ], confirmedProduct: false, businessFactsOwnedLocally: true, settings,
        privateText: containsPrivateSupplierIdentity,
        customerNotes: previous.filter(m => m.role === 'user').map(m => m.content).concat(message),
        mode: 'consult', questionPolicy: 'canonical_only',
      }, { signal: output.signal, usageContext, onInput: (facts, canonical) => { sourceTrace.answerFacts = facts; sourceTrace.answerCanonical = canonical; } });
      result.content = generated.content;
      result.responseProvider = generated.provider;
      responseReason = generated.reason;
    }
    const { interpretationProvider, ...inquiryReply } = result;
    const assistant: ChatMessage = { ...inquiryReply, id: assistantId, role: 'assistant', createdAt: now(), route: result.sourcing || result.productNameLookup ? 'sourcing' : 'consultation', groundingHash: groundingHash(result.products || [], result.knowledge, [], settings.flags, await sourcingContextRevision(conversation.id, settings)) };
    await save('messages', { ...assistant, conversationId: conversation.id, replyToId: usageContext.turnId, sourceTrace, processing: { responseProvider: assistant.responseProvider, responseModel: assistant.responseProvider === 'openai' ? responseModel(settings) : null, responseMode: 'consult', responseReason, classificationProvider: interpretationProvider, webSearch: sourceTrace.stages.some(s => s.scope !== 'registered_data'), durationMs: Date.now() - Date.parse(userCreatedAt) } }, { conversation_id: conversation.id });
    await onText?.(assistant.content);
    const { estimateRevision: _revision, ...publicAssistant } = assistant;
    return { conversationId: conversation.id, message: publicAssistant };
  }
  if (!notice && !privateQuestion && shouldUseSalesConversation(message, previous, settings)) {
    const result = await salesConversation({
      message,
      history: previous,
      settings,
      trace: sourceTrace,
      context: usageContext,
      signal: output.signal,
      handedOff: conversation.status === 'handed_off',
    });
    const assistant: ChatMessage = {
      ...result,
      id: assistantId,
      role: 'assistant',
      createdAt: now(),
      route: 'sourcing',
      groundingHash: groundingHash(
        [],
        undefined,
        [],
        settings.flags,
        sourceTrace.registeredRevision,
      ),
    };
    sourceTrace.answerCanonical = assistant.content;
    sourceTrace.answerFacts = [{ id: 'sales_stage', text: JSON.stringify(result.salesState) }];
    sourceTrace.conclusion ||= `段階：${result.salesState.stage}`;
    await db().transaction(async () => {
      await save(
        'messages',
        {
          ...assistant,
          conversationId: conversation.id,
          replyToId: usageContext.turnId,
          sourceTrace,
          processing: {
            responseProvider: assistant.responseProvider,
            responseModel: assistant.responseProvider === 'openai' ? responseModel(settings) : null,
            responseMode: 'local',
            responseReason: `sales_${result.salesState.stage}`,
            classificationProvider: 'openai',
            webSearch: sourceTrace.stages.some((s) => s.scope !== 'registered_data'),
            durationMs: Date.now() - Date.parse(userCreatedAt),
          },
        },
        { conversation_id: conversation.id },
      );
      await save(
        'conversations',
        { ...(await verifyConversation(conversation.id, owner)), updatedAt: now() },
        { owner_id: owner },
      );
      await audit('chat.sales_stage', conversation.id, `会話段階：${result.salesState.stage}`);
    })();
    await onText?.(assistant.content);
    return { conversationId: conversation.id, message: assistant };
  }
  const safeHistory = await asyncFilter(
    previous,
    async (m) => !(await privateSupplierQuestion(m.content)),
  );
  // The customer's own words, oldest first: conditions to keep and summarize.
  const customerTexts = [
    ...safeHistory.filter((m) => m.role === 'user').map((m) => m.content),
    ...(privateQuestion ? [] : [message]),
  ];
  const request = stripCourtesy(message) || message.normalize('NFKC').trim();
  const local = localIntent(message);
  const catalog = await publicProducts();
  const lastReply = previous.toReversed().find((m) => m.role === 'assistant');
  const localMatches = matchCatalog(message, local, catalog);
  const localTopic = await knowledgeTopic(message, local, lastReply);
  const routeInput = {
    message,
    intent: local,
    knownProduct: localMatches.length > 0,
    topic: localTopic,
    privateQuestion,
    previousIntent: lastReply?.intent,
    previousProduct: !!lastReply?.products?.length,
    hasContext: previous.length > 0,
  };
  const planned = planChatRoute(routeInput);
  const candidates =
    privateQuestion || (!planned.classify && planned.response === 'local')
      ? []
      : await documentCandidates(message, local);
  const registeredStage = !local.model
    ? startSourceStage(
        sourceTrace,
        'registered_data',
        message,
        [],
        '情報源・取込の登録商品・取込資料を照合',
      )
    : undefined;
  if (registeredStage)
    finishSourceStage(
      registeredStage,
      'done',
      localMatches.length || candidates.some((c) => c.matched)
        ? '登録情報を優先参照'
        : '関連する登録情報なし',
    );
  // Independent I/O starts together, only when the server policy requests it.
  const sourcingFollowup =
    !!lastReply?.sourcing &&
    !consultationTopic([request]) &&
    !/別の(?:商品|製品)|他の(?:商品|製品)/.test(request) &&
    (local.referencesPrevious ||
      isBareReply(message) ||
      /^\d+\s*(?:個|台|枚|本|セット)/.test(request) ||
      !!destinationIn([message]) ||
      ['price', 'stock', 'lead_time', 'quote', 'order'].includes(local.intent) ||
      policyKeys(request).some((k) =>
        ['sourcing', 'estimate', 'shipping', 'discount'].includes(k),
      ));
  const shouldSearchWeb =
    planned.search &&
    settings.flags.webSearch &&
    settings.searchProvider !== 'none' &&
    !local.model &&
    !sourcingFollowup;
  // Start only after classification/sourcing: an eager public search would bypass priority.
  const webWork = async () =>
    shouldSearchWeb && !intent.model && !sourcing && !candidates.some((c) => c.matched)
      ? await searchRegisteredFirst(message, settings, sourceTrace, {
          context: usageContext,
          signal: output.signal,
        })
          .then((data) => ({ data, failed: false }))
          .catch(() => ({ data: [] as Evidence[], failed: true }))
      : await Promise.resolve({ data: [] as Evidence[], failed: false });
  const intent = !planned.classify
    ? local
    : await classifyQuery(message, settings, safeHistory, {
        fields: await availableFields(),
        evidence: candidates.map((c) => c.evidence),
        signal: output.signal,
        usageContext,
      });
  // Explicit locally recognized business requests keep their meaning even if
  // a model chooses another category while identifying the requested item.
  if (local.intent !== 'product') intent.intent = local.intent;
  let matches = matchCatalog(message, intent, catalog);
  const query = normalize(message);
  // The most recent turn is the topic boundary. Never revive an older product
  // after the customer has asked about a new, unknown model.
  const last = lastReply;
  const priorProducts = last?.products || [];
  // The newest amount in the message ("40個から60個に" → 60); "1個あたり" or
  // "1本いくら" is a unit price, not an amount.
  const quantityMatch = [
    ...request.matchAll(/(?:^|[^\d])(\d{1,6})\s*(個|台|枚|本|セット|pcs|pieces|units)/gi),
  ]
    .filter(
      (m) =>
        !/(?:小箱|大箱|入数|梱包|販売単位)[：:はが\s]*$/.test(
          request.slice(Math.max(0, m.index - 12), m.index + 1),
        ) &&
        !/^(?:入り|入数|単位|と(?:書|表示|載))/.test(request.slice(m.index + m[0].length).trim()),
    )
    .filter(
      (m) =>
        !/^\s*(?:あたり|当たり|につき|いくら|おいくら|の(?:価格|単価|値段))/.test(
          request.slice(m.index + m[0].length),
        ),
    )
    .at(-1);
  const statedQuantity =
    quantityMatch && Number(quantityMatch[1]) > 0 ? Number(quantityMatch[1]) : undefined;
  const quantityFollowup =
    statedQuantity &&
    /^(?:それを|この商品を|こちらを|数量は|では|じゃあ|はい|まずは|とりあえず|やっぱり)?\s*\d/.test(
      request,
    );
  const ordinal = request.match(/^(?:では|じゃあ)?\s*([1-4一二三四])(?:番目?|つ目)/);
  const ordinalIndex = ordinal
    ? '1234'.includes(ordinal[1])
      ? Number(ordinal[1]) - 1
      : '一二三四'.indexOf(ordinal[1])
    : -1;
  let continued = false;
  // The reply the conversation continues from, for its amount.
  let continuedFrom = last;
  // "SUS304の板のほうは？" asks about another item than the previous product.
  // A product is named by its name before its category ("耐熱ガラス・鋳物").
  const namedTopic = consultationTopic([request]);
  const otherItem =
    !!namedTopic &&
    priorProducts.length > 0 &&
    !priorProducts.some((p) => consultationTopic([p.name, p.category]) === namedTopic);
  // "1個あたり8,400円で合っていますか？" points back to the product with that
  // price, even after another item was discussed.
  const quotedPrices = [...request.matchAll(/(\d[\d,]*)\s*円/g)].map((m) =>
    Number(m[1].replace(/,/g, '')),
  );
  if (!matches.length && !intent.model && quotedPrices.length) {
    const source = previous
      .toReversed()
      .find(
        (m) =>
          m.role === 'assistant' &&
          m.products?.length === 1 &&
          m.products[0].price !== null &&
          quotedPrices.includes(m.products[0].price),
      );
    if (source) {
      matches = [source.products![0]];
      continued = true;
      continuedFrom = source;
    }
  }
  if (!matches.length && !intent.model && !otherItem) {
    const branded = priorProducts.filter(
      (p) => p.manufacturer && query.includes(normalize(p.manufacturer)),
    );
    if (branded.length) {
      matches = branded;
      continued = true;
    } else if (ordinalIndex >= 0 && priorProducts[ordinalIndex]) {
      matches = [priorProducts[ordinalIndex]];
      continued = true;
    } else if (
      intent.referencesPrevious ||
      intent.intent === 'general' ||
      quantityFollowup ||
      // "税込み・送料込みだと合計いくら？" or "来週までに届く？" still asks about
      // the previous item unless another item is named ("ブラケットの価格は？").
      (businessIntents(request).length > 0 &&
        (/合計|総額|税込|送料込/.test(request) ||
          /^[\x00-\x7F]+$/.test(request) ||
          !/[\p{Script=Katakana}ー]{3,}|\p{Script=Han}{2,}の(?:価格|値段|単価|在庫|納期)/u.test(
            request,
          )))
    ) {
      matches = priorProducts;
      continued = !!matches.length;
    }
    if (
      continued &&
      intent.intent === 'product' &&
      last?.presentation === 'selection' &&
      last.intent
    )
      intent.intent = last.intent;
    if (continued && quantityFollowup && intent.intent === 'product')
      intent.intent =
        last?.intent && ['price', 'stock', 'lead_time', 'quote', 'order'].includes(last.intent)
          ? last.intent
          : 'stock';
  }
  const sameConsultation =
    !intent.model &&
    (!namedTopic || namedTopic === consultationTopic(customerTexts.slice(0, -1).toReversed()));
  let requestedQuantity =
    statedQuantity ||
    (continued || sameConsultation ? continuedFrom?.requestedQuantity : undefined);
  // "1個あたり8,400円で合っていますか？" asks the unit price; the amount of
  // the conversation is kept for the next question.
  const unitPriceAsked =
    !statedQuantity && /(?:個|台|枚|本|セット)\s*(?:あたり|当たり|につき)|単価/.test(request);
  const unit = quantityMatch
    ? /^[a-z]/i.test(quantityMatch[2])
      ? '個'
      : quantityMatch[2]
    : continued
      ? last?.factDetail?.unit
      : undefined;
  let topic = await knowledgeTopic(message, intent, last);
  // A product named now or carried from the previous answer is more specific
  // than a field remembered from history or suggested by a classifier.
  if (topic?.mode === 'fields' && matches.length && !itemFieldsFromText(message).length)
    topic = undefined;
  if (topic) matches = [];
  const route = planChatRoute({ ...routeInput, intent, knownProduct: matches.length > 0, topic });
  // Payment, shipping or hand-off questions do not change what is discussed.
  if (
    !matches.length &&
    !topic &&
    !intent.model &&
    !otherItem &&
    ['policy', 'handoff', 'transaction', 'summary'].includes(route.reason)
  ) {
    if (priorProducts.length) {
      matches = priorProducts;
      continued = true;
    } else if (last?.knowledge?.mode === 'fields' && last.knowledge.fields.length)
      topic = last.knowledge;
  }
  // A newly identified field may still need the original conversational reply.
  if (planned.response === 'ai' && !route.facts.length && route.reason !== 'privacy') {
    route.response = 'ai';
    route.reason = planned.reason;
  }
  const sourceModel =
    intent.model ||
    (!namedTopic && !/別件|別の(?:商品|製品)|他の(?:商品|製品)/.test(request)
      ? lastReply?.sourcing?.model
      : undefined);
  const sourcing =
    !privateQuestion &&
    conversation.status !== 'handed_off' &&
    !matches.length &&
    sourceModel &&
    !['privacy', 'social', 'summary', 'handoff'].includes(route.reason) &&
    (route.reason !== 'policy' ||
      policyKeys(request).some((key) =>
        ['sourcing', 'estimate', 'shipping', 'discount'].includes(key),
      )) &&
    settings.flags.webSearch &&
    settings.searchProvider !== 'none'
      ? await sourceProduct({
          model: sourceModel,
          settings,
          context: usageContext,
          signal: output.signal,
          sourceTrace,
          checkAvailability:
            /在庫|出荷|発送|納期|届/.test(request) && /調べ|探し|最新|再確認|実際/.test(request),
        }).then((result) => publicSourcing(result, settings.flags))
      : undefined;
  const rememberedSourcing =
    !sourcing &&
    !matches.length &&
    !topic &&
    !intent.model &&
    !namedTopic &&
    (sourcingFollowup || ['summary', 'handoff', 'transaction'].includes(route.reason))
      ? lastReply?.sourcing
      : undefined;
  // Keep conditions only from the current sourced item, including later quantity/destination turns.
  const sourceCorrection =
    !!sourcing &&
    !!lastReply?.sourcing &&
    /訂正|現物(?:を見たら|は|の)|(?:品番|型番).*(?:違|誤)|別の設備/.test(request);
  const sameSource =
    (sourceModel || rememberedSourcing?.model) &&
    lastReply?.sourcing &&
    normalize(lastReply.sourcing.model) === normalize(sourceModel || rememberedSourcing!.model);
  if (sourcing || rememberedSourcing)
    requestedQuantity =
      statedQuantity || (sameSource || sourceCorrection ? lastReply?.requestedQuantity : undefined);
  const sourceDestination =
    sourcing || rememberedSourcing
      ? destinationIn([message]) ||
        (sameSource || sourceCorrection ? lastReply?.requestedDestination : undefined)
      : undefined;
  const estimateResult = sourcing
    ? await sourcingEstimate(
        conversation.id,
        sourcing,
        requestedQuantity,
        sourceDestination,
        settings,
      )
    : undefined;
  const sourcedReply = () => {
    if (estimateResult?.estimate) return estimateReply(estimateResult.estimate);
    const reused = sameSource && lastReply?.sourcing?.checkedAt === sourcing!.checkedAt;
    const text =
      reused && !/在庫|出荷|発送|納期|届|掲載/.test(request)
        ? ''
        : sourcingReply(sourcing!, !!requestedQuantity);

    if (!requestedQuantity) return text || '必要な数量を教えていただけますか？';
    if (!sourceDestination)
      return `${text}\nお見積りのため、お届け先の都道府県を教えていただけますか？`;
    const packs = estimateResult?.missing.find((m) => m.startsWith('入数に合う数量'));
    if (packs)
      return `${text}\nこちらは${packs.match(/（(.+)）/)?.[1] || '梱包単位'}での販売です。ご希望の数量をご指定ください。`;
    if (estimateResult?.missing.includes('お届け先に対応する配送条件'))
      return `${text}\n${sourceDestination}への配送条件を確認してお見積りします。下の「${QUOTE_LABEL}」から連絡先をお送りください。`;
    if (reused && !text) {
      if (/見積.*(?:依頼|送|入力)|連絡先/.test(request))
        return `伺った条件は依頼に入ります。下の「${QUOTE_LABEL}」から、お名前とメールアドレスを入力して送信してください。`;
      return '承知しました。伺った条件でお見積りへ進めます。';
    }
    return `${text}\nこの条件でお見積りを承ります。下の「${QUOTE_LABEL}」から連絡先を入力してお送りください。`;
  };
  if (sourcing) {
    topic = undefined;
    route.reason = 'sourcing';
    route.response = 'local';
  }
  const evidence: Evidence[] = matches.flatMap((p) => p.evidence || []);
  let externalWarning = '';
  const external = await webWork();
  if (external.failed) externalWarning = ' Web検索は現在利用できません。';
  if (!sourcing && !topic && !matches.length && intent.intent !== 'general') {
    if (intent.evidenceIndex !== undefined && candidates[intent.evidenceIndex])
      evidence.push(candidates[intent.evidenceIndex].evidence);
    else
      evidence.push(
        ...candidates
          .filter((c) => c.matched)
          .slice(0, 3)
          .map((c) => c.evidence),
      );
    evidence.push(
      ...(await asyncFilter(
        external.data,
        async (e) =>
          e.visibility === 'public' &&
          !(await privateSupplierQuestion([e.title, e.excerpt].join(' '))) &&
          !(await containsPrivateSupplierIdentity(e.url || '')),
      )),
    );
  }

  const handedOff = conversation.status === 'handed_off';
  const quoteReceived =
    handedOff &&
    !!(await db()
      .prepare("SELECT 1 FROM quotes WHERE (json::jsonb->>'conversationId')=? LIMIT 1")
      .get(conversation.id));
  const thanks = thanksPattern.test(message);
  // The phone number is given once per conversation unless asked for again.
  const phoneShown = safeHistory.some(
    (m) => m.role === 'assistant' && m.content.includes(company.phone),
  );
  // "連絡先はどこに入力？" asks where to enter theirs, not for our number.
  const phoneAsked = /電話|番号|営業時間|何時/.test(message);
  const phone = !phoneShown || phoneAsked;
  // A question about buying this item: the reply offers the quote request.
  // Naming quantities or asking whether an item is handled counts too.
  const buying =
    !!sourcing ||
    route.facts.length > 0 ||
    /買い|買う|購入|見積|発注|注文|手配|扱って|取り?扱い|置いて(?:ます|る|い)/.test(request) ||
    /\d+\s*(?:個|台|枚|本|セット|巻|pcs)/i.test(request) ||
    policyKeys(request).some((k) =>
      [
        'discount',
        'shipping',
        'estimate',
        'payment',
        'urgent',
        'pickup',
        'quoteTime',
        'quoteItems',
        'quoteContent',
      ].includes(k),
    );
  // Once offered, the quote request stays the next step of the conversation.
  const quoteOffered = previous.some((m) => m.role === 'user' && quoteWanted(m.content));
  const quoteProduct =
    matches.length === 1 && ['available', 'orderable'].includes(matches[0].availability)
      ? matches[0]
      : undefined;
  const offered =
    !notice &&
    route.reason !== 'privacy' &&
    !handedOff &&
    (['summary', 'handoff', 'transaction', 'policy'].includes(route.reason) ||
      buying ||
      quoteOffered ||
      (route.reason === 'social'
        ? thanks && customerTexts.length >= 3
        : route.reason !== 'clarification' && customerTexts.length >= 2));
  const handoff: ChatMessage['handoff'] = !offered
    ? undefined
    : settings.flags.quoteRequests &&
        (quoteWanted(message) || quoteOffered) &&
        (buying || quoteOffered) &&
        route.transaction !== 'status' &&
        route.transaction !== 'hold' &&
        (quoteProduct || !matches.length)
      ? 'quote'
      : settings.flags.humanHandoff
        ? 'inquiry'
        : undefined;
  const guide = { label: handoff === 'quote' ? QUOTE_LABEL : HANDOFF_LABEL, phone };
  const detail = matches.length ? factDetail(message, unit) : {};
  const subject =
    topic?.mode === 'fields'
      ? topic.fields.join('・')
      : matches.length === 1
        ? `「${matches[0].name}」`
        : undefined;
  const checklistTopic = consultationTopic([
    message,
    ...(topic?.fields || []),
    ...matches.flatMap((p) => [p.name, p.category]),
    ...customerTexts.toReversed(),
    ...safeHistory
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content)
      .toReversed(),
  ]);
  // Conditions given for another registered item ("別件で、DEMO-CAST-01を4個")
  // do not belong to the current topic.
  const otherModels = catalog
    .filter((p) => !matches.some((m) => m.id === p.id))
    .map((p) => normalize(p.model));
  const topicTexts = customerTexts.filter(
    (text, i) =>
      i === customerTexts.length - 1 ||
      (!otherModels.some((model) => normalize(text).includes(model)) &&
        [undefined, checklistTopic].includes(consultationTopic([text]))),
  );
  const compose = {
    customerTexts: topicTexts,
    allCustomerTexts: customerTexts,
    topic: checklistTopic,
    label: subject,
    // Whether a named registered product is handled comes first.
    lead: isBareReply(message)
      ? undefined
      : matches.length === 1
        ? productReply(matches, 'product', settings).split('\n')[0]
        : intent.model && !matches.length
          ? `「${intent.model}」は登録商品にはありませんが、お取り寄せを含めて当社で確認します。`
          : undefined,
    previousReplies: safeHistory.filter((m) => m.role === 'assistant').map((m) => m.content),
    handoff: (settings.flags.humanHandoff || handoff === 'quote') && !handedOff,
    guideLabel: guide.label,
    phone,
    destination: sourcing || rememberedSourcing ? sourceDestination : destinationIn(customerTexts),
  };
  // Terms, urgency and company questions have fixed answers. A registered
  // price reply already explains shipping.
  const confirmSaid = safeHistory.some(
    (m) => m.role === 'assistant' && m.content.includes(CONFIRM_PHRASE),
  );
  // "価格・在庫" from earlier "…の価格・在庫は、仕様と数量をもとに…" statements.
  const confirmedLabels = new Set(
    safeHistory
      .filter((m) => m.role === 'assistant')
      .flatMap((m) =>
        [...m.content.matchAll(/の([^。「」]{1,24}?)は、仕様と数量をもとに/g)].flatMap((x) =>
          x[1].split('・'),
        ),
      ),
  );
  const policyFull =
    route.reason === 'privacy' || route.reason === 'social'
      ? ''
      : policyAnswers(
          message,
          [
            ...(matches.length && route.facts.includes('price') ? (['shipping'] as const) : []),
            // A price reply already says how an unregistered price is given,
            // the first time it is said in the conversation.
            ...(route.facts.includes('price') && route.reason !== 'transaction' && !confirmSaid
              ? (['estimate'] as const)
              : []),
          ],
          phone,
          settings.faq,
        );
  // A demo record must not be mistaken for an actual offer.
  const demoNotice =
    matches.length === 1 &&
    matches[0].isDemo &&
    /デモ(?:です|なの|情報|用)|確認用(?:です|なの|の情報)|実物|本物|実際の販売|実際に買/.test(
      message,
    )
      ? `「${matches[0].name}」は確認用のデモ情報で、実際の販売条件ではありません。`
      : '';
  // The topic of an unanswerable price question ("いくら？") is what the
  // customer has been describing, not a request for a model number.
  const customerTopic = consultationTopic(customerTexts.toReversed());
  // The same applies while a consultation is going on, even if its item was
  // described in words the local vocabulary does not know ("あついところのまど").
  const consulting = ['consultation', 'discovery', 'summary', 'policy', 'handoff'].includes(
    lastReply?.route || '',
  );
  if (route.reason === 'clarification' && customerTexts.length > 1 && (customerTopic || consulting))
    route.response = 'mixed';
  // Fixed procedure sentences are given once per conversation: repeated, they
  // made replies long and beside the point. Registered values are always given.
  const said = new Set(compose.previousReplies.flatMap(sentencesOf));
  const quoteTimeAsked = policyKeys(request).includes('quoteTime');
  const unregisteredFacts = () => {
    const asked = route.facts
      // "10月17日までに見積をいただけますか" asks about the quote, not delivery.
      .filter((f) => f !== 'lead_time' || !quoteTimeAsked)
      .map((f) => ({ price: '価格', stock: '在庫', lead_time: 'お届け時期' })[f as 'price'])
      .filter(Boolean)
      .join('・');
    return asked || !quoteTimeAsked
      ? `${topicName(customerTopic) || 'ご希望の品'}の${asked || 'お見積り'}は、${CONFIRM_PHRASE}`
      : '';
  };
  // A model not in the registry may still be sourced; it is not refused.
  const unknownModel = () => {
    const asked = route.facts
      .map((f) => ({ price: '価格', stock: '在庫', lead_time: 'お届け時期' })[f as 'price'])
      .filter(Boolean)
      .join('・');
    const lead = `「${intent.model}」は登録商品にはありませんが、${asked ? `${asked}も含めて、` : ''}お取り寄せできるか当社で確認します。`;
    // Only the amount is asked for; a maker named in another way ("バンドーの
    // レッドS-II") was asked for again.
    const counted = customerTexts.some((t) => /\d+\s*(?:個|台|枚|本|セット|巻|pcs)/i.test(t));
    return route.response === 'local' && !counted
      ? `${lead}\n必要な数量を教えていただけますか？`
      : lead;
  };
  const facts = async () =>
    topic
      ? await knowledgeReply(topic, settings, route.facts)
      : matches.length
        ? factualReply(
            matches,
            route.facts,
            intent.intent,
            settings,
            unitPriceAsked ? undefined : requestedQuantity,
            detail,
          )
        : evidence.length
          ? '関連する資料・候補が見つかりました。資料の記載だけでは販売・取り寄せ可否を確定できないため、条件を確認してお見積りにつなげます。'
          : intent.model
            ? unknownModel()
            : // An item already described is not asked for again.
              customerTopic
              ? unregisteredFacts()
              : missingProductReply(intent.intent);
  // The fixed part a reply starts with; empty when the whole reply is a
  // conversation written by the response model. With repeat, sentences given
  // earlier in the conversation are kept (used when nothing else can answer).
  const fixedPart = async (repeat: boolean) => {
    if (notice) return notice;
    const once = (text: string) => (repeat ? text : unsaid(text, said));
    // The statement that the staff confirms unregistered values is given once
    // for each of price, stock and delivery.
    const statement = (text: string) => {
      const labels = text.match(/の([^。「」]{1,24}?)は、仕様と数量をもとに/)?.[1].split('・');
      return once(
        !repeat && labels && labels.every((label) => confirmedLabels.has(label)) ? '' : text,
      );
    };
    const join = (...parts: string[]) => parts.filter(Boolean).join('\n');
    const policy = once(policyFull);
    if (sourcing) return sourcedReply();
    if (route.reason === 'social')
      return socialOnly(message)
        ? thanks
          ? `どういたしまして。${
              customerTexts.length >= 3 && compose.handoff
                ? `ここまでの内容でお見積りをご希望でしたら、下の「${guide.label}」から送れます。`
                : 'ほかに確認したいことがあれば、そのまま続けてお聞きください。'
            }`
          : introduction
        : topic
          ? await knowledgeReply(topic, settings)
          : introduction;
    if (route.reason === 'policy')
      return join(
        policy,
        route.facts.length
          ? matches.length
            ? await facts()
            : statement(topic ? await facts() : unregisteredFacts())
          : '',
      );
    if (
      route.reason === 'transaction' &&
      route.transaction === 'quote' &&
      !matches.length &&
      !customerTopic &&
      !intent.model &&
      customerTexts.length === 1
    )
      return 'お見積りをご希望ですね。まず、商品名・型番、または用途と必要な数量を教えていただけますか？まだ見積依頼は送信されていません。';
    if (route.reason === 'transaction')
      return join(
        policy,
        once(
          // What to write is already answered; only the way to send remains.
          route.transaction === 'quote' &&
            matches.length !== 1 &&
            policyKeys(request).includes('quoteItems')
            ? handoffGuide(settings.flags.humanHandoff, guide.label, guide.phone)
            : transactionReply(route.transaction!, settings, matches, handedOff, guide),
        ),
      );
    if (route.reason === 'handoff')
      return join(
        once(handoffReply(settings, thanks, handedOff, guide, /電話(?:で|し|を)/.test(request))),
        policy,
      );
    if (route.reason === 'clarification' && route.response === 'mixed')
      return join(statement(unregisteredFacts()), policy);
    if (route.response === 'ai') return '';
    // An unregistered model is introduced once; later questions about it are
    // answered in conversation.
    const modelSaid =
      !!intent.model &&
      compose.previousReplies.some((r) =>
        r.includes(`「${intent.model}」は登録商品にはありません`),
      );
    const answer = join(
      matches.length
        ? await facts()
        : intent.model && !topic && !repeat && modelSaid
          ? ''
          : statement(await facts()),
      policy,
    );
    // A field has no registered values, so the next step comes from the
    // conversation instead of a request for a model number.
    return route.reason === 'facts' && route.response === 'local' && topic?.mode === 'fields'
      ? join(answer, once(composeConsultation(compose, 'next')))
      : answer;
  };
  let fixed = await fixedPart(false);
  // Conversation-dependent text cannot be rebuilt from registered facts later.
  let composed =
    route.response !== 'local' ||
    !['facts', 'lookup'].includes(route.reason) ||
    !matches.length ||
    !!policyFull ||
    !!demoNotice ||
    // A unit price answered for a conversation with an amount.
    unitPriceAsked;
  if (demoNotice && fixed) fixed = `${demoNotice}\n${fixed}`;
  // Everything fixed was said before: the response model answers in
  // conversation, or the fixed answer is given again without one.
  const aiReady =
    settings.responseProvider !== 'local' &&
    !!process.env[settings.responseProvider === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY'];
  if (
    sourcing &&
    !estimateResult?.estimate &&
    aiReady &&
    /(?:同じ|違い|分け|区別|確約|保証|測り|測れ|単位|だけで|のみ|という表示)/.test(request) &&
    /[?？]|でしょうか|ですか|ますか|教え|どう|なぜ|違い/.test(request)
  )
    route.response = 'mixed';
  if (
    sourcing &&
    /出荷|発送/.test(request) &&
    /到着|届/.test(request) &&
    /同じ|分け|区別|確約|決ま|保証|わけ/.test(request)
  ) {
    route.response = 'local';
    fixed = /翌日|明日/.test(request)
      ? '「最短当日出荷」だけでは翌日の到着は確定しません。配送経路と必要数量を確認し、お届け予定日をお見積りでご案内します。'
      : '出荷日は送り出す日、到着日はお客様へ届く日です。配送経路と日数を含め、お届け予定日をお見積りでご案内します。';
  } else if (
    sourcing &&
    /小箱|入数|入り|梱包単位/.test(request) &&
    /だけ|のみ|小分け|単位/.test(request)
  ) {
    route.response = 'local';
    fixed =
      '小箱の入数と小分けでの販売可否は別に確認が必要です。伺った数量での手配可否と金額をお見積りします。';
  } else if (sourcing && /到着|届/.test(request) && /見積/.test(request)) {
    route.response = 'local';
    fixed = 'はい。ご希望の時期も添えて、送料・お届け予定日をお見積りでご案内します。';
  }
  if (sourcing && /連絡先|入力先|入力.*画面|どこ.*入力/.test(request)) {
    route.response = 'local';
    fixed = sourcedReply();
  }
  if (sourcing && !fixed.trim()) fixed = sourcedReply();
  const repeated = !fixed.trim() && route.response !== 'ai';
  // Taken before the route changes: the fixed answer given again is what the
  // response model restates, and what is shown if it cannot answer.
  const givenBefore = repeated ? await fixedPart(true) : '';
  if (repeated) {
    if (aiReady && !['privacy', 'social'].includes(route.reason)) route.response = 'ai';
    else fixed = givenBefore;
    composed = true;
  }
  fixed += externalWarning;
  // A supplied specification is an answer, not a reason to ask the same details again.
  if (
    !sourcing &&
    !rememberedSourcing &&
    !matches.length &&
    !privateQuestion &&
    handoff === 'quote' &&
    lastReply &&
    requestedQuantity &&
    compose.destination &&
    !route.facts.length &&
    route.response !== 'local' &&
    !/[?？]|ですか|ますか|でしょうか|教え|どう|なぜ|どこ|方法|違い/.test(request)
  ) {
    route.response = 'local';
    fixed = /未定|未確定|まだ|確認中|分から|わから/.test(request)
      ? '未確定の項目は後から追記いただけます。分かっている条件でお見積りを相談いただけます。'
      : '承知しました。伺った条件でお見積りへ進めます。';
  }
  if (handedOff && !privateQuestion && !notice) {
    route.response = 'local';
    fixed = /追記|追加|寸法を測/.test(request)
      ? 'ご依頼を受け付けています。追加の寸法や条件は、このチャットにお書きください。ご依頼に添えて確認します。'
      : quoteReceived
        ? '見積依頼を受け付けています。内容を確認してお見積りをご案内します。金額・納期をご確認いただいてから、ご注文へ進めます。'
        : 'ご相談を受け付けています。当社で内容を確認してご連絡します。追加の条件があれば、このチャットでお知らせください。';
  }
  if (
    !handedOff &&
    customerTopic === 'ベルト' &&
    /一周|全周|長さ/.test(request) &&
    /どう.*(?:測|はか)|測り方|計測方法|測定方法|(?:測|はか).*(?:よい|良い|いい|教え|方法)/.test(
      request,
    )
  ) {
    route.response = 'local';
    fixed =
      '設備を停止し、誤って動かない状態にしてから、ベルトに印を付けて一周分の長さを測ってください。取り外せる場合も輪の全周を測ります。コンベヤの端から端の長さや、プーリーの円周とは異なります。全周長が分かれば、伺った幅・厚み・本数でお見積りを進めます。';
  }
  const rules =
    topic?.mode === 'fields'
      ? `「${topic.fields.join('」「')}」は相談を受け付けている取扱分野です。個別製品の仕様・対応可否、価格・在庫・納期は当社で確認します。`
      : matches.length === 1
        ? `「${matches[0].name}」（型番${matches[0].model}）は登録商品です。${
            matches[0].isDemo ? '確認用のデモデータで、実際の販売条件ではありません。' : ''
          }${
            matches[0].availability === 'needs_review'
              ? '現在の取扱条件は当社で確認中です。'
              : matches[0].availability === 'unavailable'
                ? '現在は取扱対象外として登録されています。'
                : ''
          }用途への適合や個別の対応可否は当社で確認します。`
        : matches.length > 1
          ? `候補の登録商品: ${matches.map((p) => `「${p.name}」`).join('')}。どの商品かはお客様に確認が必要です。`
          : evidence.length
            ? '関連する資料・候補があります。資料の記載だけでは販売・取り寄せ可否を確定できないため、条件を確認してお見積りにつなげます。'
            : intent.model
              ? `「${intent.model}」は登録商品ではありません。取り寄せの可否・価格・在庫・納期は当社で確認します。取扱いがないとは言わない。`
              : intent.intent === 'custom'
                ? '図面や仕様をもとに、設計・製作のご相談を承ります。製作可否・価格・納期は当社で確認します。'
                : '個別製品の対応可否・価格・在庫・納期は当社で確認します。';
  const conditions = statedConditions(topicTexts);
  const policyNext = unsaid(
    consultationTopic([message])
      ? composeConsultation(compose, 'next')
      : compose.handoff
        ? handoffGuide(true, guide.label, false)
        : '',
    said,
  );
  if (route.reason === 'policy' && route.response === 'local' && policyNext)
    fixed += `\n${policyNext}`;
  const fallback = sourcing
    ? sourcedReply()
    : repeated
      ? givenBefore
      : route.reason === 'handoff'
        ? conditions.length
          ? `伺った条件（${conditions.join('・')}）も、この会話と一緒に依頼に引き継がれます。`
          : ''
        : route.reason === 'policy'
          ? policyNext
          : route.response === 'mixed'
            ? composeConsultation({ ...compose, guided: fixed.includes(guide.label) }, 'next')
            : route.reason === 'summary'
              ? summarizeConsultation(compose)
              : intent.intent === 'general' || (topic?.mode === 'fields' && topic.fields.length > 2)
                ? topic
                  ? await knowledgeReply(topic, settings)
                  : introduction
                : composeConsultation({
                    ...compose,
                    lead: [demoNotice, compose.lead].filter(Boolean).join('\n') || undefined,
                  });
  if (!privateQuestion && !sourcing && !matches.length && asksOneMissingPoint(message)) {
    route.response = 'local';
    fixed = oneMissingPoint(compose);
  }
  const fields = await availableFields();
  if (route.response === 'mixed') await output.onText?.(fixed);
  const generated =
    route.response !== 'local'
      ? await generateGroundedReply(
          {
            question: message,
            history: safeHistory,
            customerNotes: customerTexts,
            mode: sourcing
              ? 'sourcing'
              : route.reason === 'summary'
                ? 'summary'
                : route.response === 'mixed'
                  ? 'supplement'
                  : 'consult',
            canonical: sourcing ? sourcedReply() : route.response === 'mixed' ? fixed : rules,
            ...(repeated && givenBefore ? { answer: givenBefore } : {}),
            // Without the model, sentences given earlier are not repeated either.
            fallback: route.reason === 'summary' ? fallback : unsaid(fallback, said) || fallback,
            settings,
            facts: [
              ...(sourcing ? [{ id: 'sourcing_outcome', text: sourcedReply() }] : []),
              { id: 'business_rules', text: rules },
              ...(await asyncMap(matches, async (p, i) => ({
                id: `product_${i}`,
                text: JSON.stringify({
                  name: p.name,
                  model: p.model,
                  description:
                    p.approved && !(await privateSupplierQuestion(p.description))
                      ? p.description
                      : '',
                  specifications:
                    p.approved && !(await privateSupplierQuestion(p.specifications))
                      ? p.specifications
                      : '',
                }),
              }))),
              ...evidence.slice(0, 6).map((e, i) => ({
                id: `evidence_${i}`,
                text: `${e.title}: ${e.excerpt}`,
              })),
              {
                id: 'selection_points',
                text: `${checklistTopic || '部品'}の選定で確認する主な項目: ${checklist(checklistTopic).join('、')}`,
              },
              ...(policyFull
                ? [
                    {
                      id: 'policies',
                      text: `この質問への会社の決まった回答: ${policyFull}`,
                    },
                  ]
                : []),
              {
                id: 'contact',
                text: handedOff
                  ? 'この会話はご相談として受付済みです。当社で内容を確認してご連絡します。'
                  : handoff
                    ? `${handoffGuide(settings.flags.humanHandoff || handoff === 'quote', guide.label, phone)}${
                        phone ? '' : '電話番号は案内済みのため書かない。'
                      }`
                    : 'この返答の下にボタンは表示されない。ボタン名や送信方法は書かない。',
              },
              {
                id: 'company',
                text: [companyFact(), faqFact(settings.faq)].filter(Boolean).join(' '),
              },
              ...(fields.length
                ? [{ id: 'fields', text: `相談を受け付けている取扱分野: ${fields.join('、')}` }]
                : []),
            ],
            // The AI writes consultation text only. Even for a registered product,
            // business facts and confirmation of sales remain locally authored.
            confirmedProduct: false,
            businessFactsOwnedLocally: true,
            privateText: privateSupplierQuestion,
          },
          {
            usageContext,
            onGrounding: (blocks) => {
              sourceTrace.answerBlocks = blocks;
            },
            onInput: (facts, canonical) => {
              sourceTrace.answerFacts = facts;
              sourceTrace.answerCanonical = canonical;
            },
            // A rejected draft is rewritten only while the reply can still
            // finish within the response time budget.
            retryUntil: Date.parse(userCreatedAt) + budgets.retry,
            signal: AbortSignal.any([
              output.signal!,
              AbortSignal.timeout(
                Math.max(
                  100,
                  budgets.generation - (sourcing ? 0 : Date.now() - Date.parse(userCreatedAt)),
                ),
              ),
            ]),
            onText: (text) =>
              output.onText?.(
                route.response === 'mixed' ? [fixed, text].filter(Boolean).join('\n\n') : text,
              ),
          },
        )
      : { content: fixed, provider: 'local' as const, reason: route.reason };
  // A registered price is followed once by the way to get the formal quote.
  const quoteInvite =
    handoff === 'quote' &&
    quoteProduct &&
    route.reason === 'facts' &&
    !compose.previousReplies.some((r) => r.includes(QUOTE_LABEL))
      ? `下の「${QUOTE_LABEL}」から、数量とご連絡先だけで正式なお見積りを依頼できます。`
      : '';
  // With the invitation, "正式な金額は、お見積りで…" would say the same twice.
  const offerText = (text: string) =>
    quoteInvite
      ? text.replace(/(?:数量や送料を含む)?正式な金額(?:と条件)?は、お見積りでご案内します。/, '')
      : text;
  // Suggested next questions change with the conversation: one already asked,
  // the quote request already offered by the button, or the same set as last
  // time is not shown again.
  const followUps = (options: string[]) => {
    const asked = new Set(customerTexts.map((t) => t.normalize('NFKC').trim()));
    const shown = options.filter((o) => !asked.has(o) && !(handoff === 'quote' && /見積/.test(o)));
    const last = (lastReply?.suggestions || []).join('\n');
    if (!shown.length || shown.join('\n') !== last) return shown;
    const summary = ['ここまでの内容をまとめてください'];
    return customerTexts.length >= 3 && route.reason !== 'summary' && last !== summary[0]
      ? summary
      : [];
  };
  const finish = (text: string) =>
    buttonLabels(onePhoneNumber(offerText(text), phone), handoff ? guide.label : undefined);
  let content = finish(
    [
      route.response === 'mixed'
        ? [fixed, sourcing && generated.provider === 'local' ? '' : generated.content]
            .filter(Boolean)
            .join('\n\n')
        : route.response === 'ai'
          ? generated.content + externalWarning
          : generated.content,
      quoteInvite,
    ]
      .filter(Boolean)
      .join('\n'),
  );
  // A reply is never empty, even when every sentence was said before and
  // no response model could answer.
  if (!content.trim())
    content =
      finish(givenBefore || (await fixedPart(true))) ||
      finish(composeConsultation(compose, 'next')) ||
      'ご相談の内容は、この会話をもとにご案内します。';
  if (output.signal?.aborted) throw new Error('処理が中断されました');
  if (estimateResult?.estimate) content = estimateReply(estimateResult.estimate);

  if (!sourcing) {
    const stage =
      registeredStage ||
      startSourceStage(
        sourceTrace,
        'registered_data',
        message,
        [],
        '情報源・取込の登録商品・取込資料を照合',
      );
    for (const p of matches) {
      const raw = await byId<Product>('products', p.id);
      const source = raw?.sourceId ? await byId<Source>('sources', raw.sourceId) : undefined;
      sourceTrace.observations.push({
        title: source ? `${source.name}：${p.name}` : p.name,
        url: source?.url || '',
        sourceId: source?.id,
        origin: 'registered_data',
        outcome: 'identified',
        reason: '登録商品を参照。承認・確認期限と表示設定を適用',
        excerpt: JSON.stringify(raw || p),
        retrievedAt: raw?.updatedAt || p.updatedAt,
      });
    }
    for (const candidate of candidates.filter((c) => c.matched)) {
      const e = candidate.evidence;
      const doc = e.id
        ? await byId<{ title: string; content: string; url: string; createdAt: string }>(
            'documents',
            e.id,
          )
        : undefined;
      const source = e.sourceId ? await byId<Source>('sources', e.sourceId) : undefined;
      sourceTrace.observations.push({
        title: source ? `${source.name}：${doc?.title || e.title}` : e.title,
        url: doc?.url || e.url || '',
        sourceId: e.sourceId,
        origin: 'registered_data',
        outcome: 'identified',
        reason: '取込資料に関連記載あり。資料だけで販売条件を確定しない',
        excerpt: doc?.content.slice(0, 2000) || e.excerpt,
        retrievedAt: doc?.createdAt || e.retrievedAt,
      });
    }
    finishSourceStage(
      stage,
      'done',
      matches.length || candidates.some((c) => c.matched)
        ? '登録情報を優先参照'
        : '関連する登録情報なし',
    );
  }
  sourceTrace.answerFacts ||= [
    ...(sourcing
      ? [{ id: 'sourcing_outcome', text: sourcedReply() }]
      : [{ id: 'business_rules', text: rules }]),
    ...matches.map((p, i) => ({
      id: `product_${i}`,
      text: JSON.stringify({
        name: p.name,
        model: p.model,
        description: p.approved ? p.description : '',
        specifications: p.approved ? p.specifications : '',
      }),
    })),
    ...evidence
      .slice(0, 6)
      .map((e, i) => ({ id: `evidence_${i}`, text: `${e.title}: ${e.excerpt}` })),
  ];
  sourceTrace.conclusion ||= sourcing
    ? sourcedReply()
    : matches.length
      ? '登録商品をもとに回答'
      : evidence.length
        ? '関連資料・検索候補をもとに相談を案内。発注可否は担当者確認'
        : '該当商品の確認情報なし。一般相談・会社案内または担当者確認';
  const assistant: ChatMessage = {
    id: assistantId,
    role: 'assistant',
    content,
    ...(sourcing || rememberedSourcing ? { sourcing: sourcing || rememberedSourcing } : {}),
    ...(estimateResult?.estimate
      ? { estimate: estimateResult.estimate, estimateRevision: estimateResult.revision }
      : {}),
    responseProvider: generated.provider,
    groundingHash: groundingHash(
      matches,
      topic,
      evidence,
      settings.flags,
      await sourcingContextRevision(conversation.id, settings),
    ),
    knowledge: topic,
    products: notice ? [] : matches,
    evidence,
    intent: intent.intent,
    factualIntents: route.facts,
    requestedQuantity,
    ...(sourceDestination ||
    destinationIn([message]) ||
    (sameConsultation ? lastReply?.requestedDestination : undefined)
      ? {
          requestedDestination:
            sourceDestination || destinationIn([message]) || lastReply?.requestedDestination,
        }
      : {}),
    ...(Object.keys(detail).length ? { factDetail: detail } : {}),
    route: route.reason,
    ...(composed || quoteInvite ? { composed: true } : {}),
    ...(handoff
      ? {
          handoff,
          handoffDraft:
            (estimateResult?.estimate ? estimateReply(estimateResult.estimate) + '\n\n' : '') +
            handoffDraft(
              customerTexts,
              route.reason === 'summary' && generated.provider !== 'local'
                ? generated.content
                : undefined,
              compose.destination,
            ),
          ...(handoff === 'quote' && quoteProduct ? { handoffProductId: quoteProduct.id } : {}),
        }
      : {}),
    presentation: topic
      ? 'reply'
      : matches.length > 1 && intent.intent !== 'general'
        ? 'selection'
        : continued || intent.intent === 'general'
          ? 'reply'
          : 'products',
    suggestions: notice
      ? []
      : followUps(
          route.reason === 'privacy'
            ? ['どんな製品を扱っていますか？']
            : ['summary', 'handoff', 'transaction'].includes(route.reason)
              ? []
              : topic
                ? topic.mode === 'fields'
                  ? ['この分野の見積を相談したい', '必要な仕様を相談したい']
                  : ['どんな製品を扱っていますか？']
                : intent.intent === 'custom'
                  ? ['図面がなくても相談できますか？']
                  : matches.length > 1
                    ? matches.map(
                        (p) =>
                          `${p.manufacturer ? p.manufacturer + ' ' : ''}${p.model || p.name}${intent.intent === 'lead_time' ? 'の納期は？' : intent.intent === 'price' ? 'の価格は？' : intent.intent === 'stock' ? 'の在庫は？' : 'について教えて'}`,
                      )
                    : matches.length
                      ? [
                          intent.intent !== 'lead_time' && 'いつぐらいに届く？',
                          intent.intent !== 'price' && '価格は？',
                          settings.flags.quoteRequests &&
                            intent.intent !== 'quote' &&
                            '見積を依頼したい',
                        ].filter((s): s is string => !!s)
                      : customerTexts.length >= 2
                        ? ['ここまでの内容をまとめてください']
                        : ['選ぶときのポイントを教えてください'],
        ),
    createdAt: now(),
  };
  await db().transaction(async () => {
    await save(
      'conversations',
      { ...(await verifyConversation(conversation.id, owner)), updatedAt: now() },
      { owner_id: owner },
    );
    await save(
      'messages',
      {
        ...assistant,
        conversationId: conversation.id,
        replyToId: usageContext.turnId,
        sourceTrace,
        processing: {
          classificationProvider: intent.provider,
          responseProvider: estimateResult?.estimate ? 'local' : generated.provider,
          responseMode: estimateResult?.estimate ? 'local' : route.response,
          responseReason: estimateResult?.estimate ? 'estimate' : generated.reason,
          responseModel:
            generated.provider === 'local' || estimateResult?.estimate
              ? null
              : responseModel(settings),
          durationMs: Date.now() - Date.parse(userCreatedAt),
          webSearch: !!(shouldSearchWeb || sourcing),
        },
      },
      { conversation_id: conversation.id },
    );
    await audit(
      'chat.routed',
      conversation.id,
      `振り分け:${CHAT_ROUTE_LABELS[route.reason]} / ${route.reason} / 分類:${intent.provider} / 回答:${generated.provider} / ${generated.reason} / Web:${shouldSearchWeb || sourcing ? '実行' : '省略'} / ${Date.now() - Date.parse(userCreatedAt)}ms`,
    );
  })();
  await onText?.(content);
  // Staff-only research of the price, stock, lead time or shipping of an item
  // the registry cannot answer. It runs after the reply and never reaches the
  // customer.
  const registered =
    matches.length === 1 &&
    matches[0].price !== null &&
    !!matches[0].leadTime &&
    ['available', 'orderable'].includes(matches[0].availability);
  const asked: ResearchAspect[] = [
    ...(['price', 'stock', 'lead_time'] as const).filter((a) => route.facts.includes(a)),
    ...(policyKeys(request).includes('shipping') ? (['shipping'] as const) : []),
  ];
  const aspects = registered ? asked.filter((a) => a === 'shipping') : asked;
  if (
    settings.flags.aiResearch &&
    !sourcing &&
    output.defer &&
    !privateQuestion &&
    !['privacy', 'social'].includes(route.reason) &&
    !matches.some((p) => p.isDemo) &&
    (!registered || aspects.length)
  ) {
    const available = await availableFields();
    output.defer(
      async () =>
        await researchForStaff(
          {
            conversationId: conversation.id,
            turnId: usageContext.turnId,
            message,
            customerTexts,
            subject:
              matches.length === 1
                ? [matches[0].manufacturer, matches[0].name, matches[0].model]
                    .filter(Boolean)
                    .join(' ')
                : researchSubject(customerTexts, catalog),
            // Fields of the item itself: bearings for a pump motor do not send
            // the search to pump makers.
            fields: [
              ...new Set([...(topic?.fields || []), ...topicTexts.flatMap(itemFieldsFromText)]),
            ].filter((f) => available.includes(f)),
            destination:
              sourcing || rememberedSourcing ? sourceDestination : destinationIn(customerTexts),
            quantity: statedQuantities(topicTexts),
            local: {
              research:
                buying &&
                (matches.length > 0 || !!intent.model || statedConditions(topicTexts).length > 0),
              aspects: aspects.length ? aspects : ['price', 'lead_time'],
            },
          },
          usageContext,
        ),
    );
  }
  const { estimateRevision: _privateRevision, ...publicAssistant } = assistant;
  return { conversationId: conversation.id, message: publicAssistant };
}
// Every item the customer described, without demo records, which are not
// researched. A long conversation keeps its start (the items) and its end
// (the latest changes).
function researchSubject(texts: string[], catalog: Product[]) {
  const demo = catalog.filter((p) => p.isDemo).flatMap((p) => [p.model, p.name]);
  const joined = texts
    .map((t) => demo.reduce((text, word) => text.replaceAll(word, ''), t.normalize('NFKC')))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return joined.length > 600 ? `${joined.slice(0, 280)} … ${joined.slice(-300)}` : joined;
}
// Sentences of a reply, compared without the phone number, which is given
// only once per conversation.
function sentencesOf(text: string) {
  return text
    .split(/(?<=[。？！?!])|\n/)
    .map((s) => s.replace(/[（(]?\d{2,4}-\d{2,4}-\d{3,4}[）)]?/g, '').trim())
    .filter(Boolean);
}
// The text without sentences already given in this conversation.
function unsaid(text: string, said: Set<string>) {
  return text
    .split('\n')
    .map((line) =>
      line
        .split(/(?<=[。？！?!])/)
        .filter((s) => !sentencesOf(s).every((part) => said.has(part)))
        .join(''),
    )
    .filter((line) => line.trim())
    .join('\n');
}
// The phone number appears at most once in a reply, and not again once the
// conversation has given it. A later sentence with the number is removed as
// a whole; removing only the number left broken sentences ("急ぎの場合はへ").
function onePhoneNumber(content: string, allowed: boolean) {
  let shown = !allowed;
  return content
    .split(/(?<=[。？！?!])/)
    .map((sentence) => {
      if (!sentence.includes(company.phone)) return sentence;
      if (!shown) {
        shown = true;
        return sentence;
      }
      return sentence.match(/^\s*/)![0].includes('\n') ? '\n' : '';
    })
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
// The reply names the button actually shown under it.
function buttonLabels(content: string, label?: string) {
  const labels = [QUOTE_LABEL, HANDOFF_LABEL];
  if (!label)
    return content
      .split(/(?<=[。？！?!])/)
      .filter((sentence) => !labels.some((l) => sentence.includes(l)))
      .join('')
      .trim();
  return labels.reduce((text, l) => (l === label ? text : text.replaceAll(l, label)), content);
}
export async function currentMessages(id: string): Promise<ChatMessage[]> {
  const settings = await getSettings();
  const restorationTrace = await createSourceTrace();
  const registeredRevision = restorationTrace.registeredRevision;
  const fields = await availableFields();
  const sourceContext = await sourcingContextRevision(id, settings);
  // Partial replies remain in the staff transcript; only completed replies
  // can be restored publicly or used as context for the next answer.
  const storedMessages=(await conversationMessages(id)) as StoredChatMessage[];
  return await asyncMap(
    storedMessages
      .filter((m) => !m.incomplete)
      .map(
        ({
          replyToId: _replyToId,
          processing: _processing,
          sourceTrace: _sourceTrace,
          ...message
        }) => message,
      ),
    async (original) => {
      if (original.productNameLookup && (original.inquiryState?.designation || original.inquiryState?.model || original.inquiryState?.researchSubject)) {
        const latest = await lookupProductName((original.inquiryState.designation || original.inquiryState.model || original.inquiryState.researchSubject)!, { trace: structuredClone(restorationTrace), settings: { ...settings, flags: { ...settings.flags, webSearch: false } }, context: { scope: 'chat' } });
        const lookup: NonNullable<ChatMessage['productNameLookup']> = latest.status === 'identified' ? { ...latest, investigation: original.productNameLookup.investigation } : original.productNameLookup.status === 'identified' ? latest : {...original.productNameLookup};
        if(lookup.candidates?.length) {
          const subject=(original.inquiryState.designation||original.inquiryState.model||original.inquiryState.researchSubject)!;
          const current=(await productCandidates(subject)).map(c=>c.product);
          const evidence=storedMessages.find(m=>m.id===original.id)?.sourceTrace?.investigation?.evidence||[];
          const records=await list<{sourceId:string;url:string;createdAt:string}>('documents');
          const validEvidence: typeof evidence=[];
          for(const e of evidence) if(Date.now()-Date.parse(e.checkedAt)<86400000 && (!e.sourceId || ((await byId<Source>('sources',e.sourceId))?.enabled && records.some(d=>d.sourceId===e.sourceId&&d.url===e.url&&d.createdAt===e.checkedAt))))validEvidence.push(e);
          lookup.candidates=lookup.candidates.filter(c=>current.some(p=>p.name===c.name&&p.model===c.model)||validEvidence.some(e=>e.entries.some(p=>p.name===c.name&&p.model===c.model)));
        }
        // Restoring history must not replace a grounded answer with the identity
        // template. Revalidate its current records and verbatim passages without
        // another model call or external request.
        const identities = (value: NonNullable<ChatMessage['productNameLookup']>) => JSON.stringify([value.status, value.matches.map(p=>[p.name,p.model||'']).sort(), (value.candidates||[]).map(p=>[p.name,p.model||'']).sort()]);
        let retain = identities(lookup) === identities(original.productNameLookup)
          && original.groundingHash === groundingHash(original.products || [], original.knowledge, [], settings.flags, sourceContext);
        const facts = storedMessages.find(m=>m.id===original.id)?.sourceTrace?.answerFacts?.filter(f=>f.id.startsWith('product_passage_')) || [];
        const documents = facts.length ? await list<{sourceId:string;url:string;detailOf?:string;content:string;createdAt:string}>('documents') : [];
        for (const fact of facts) {
          let valid = false;
          for (const doc of documents) {
            const age=Date.now()-Date.parse(doc.createdAt);
            if(!Number.isFinite(age) || age<0 || age>7*86400000 || !doc.content.replace(/\s+/g,' ').trim().includes(fact.text) || !preferredSiteFor(doc.detailOf || doc.url,restorationTrace)) continue;
            const source=await byId<Source>('sources',doc.sourceId);
            if(source?.enabled && (source.kind!=='supplier_catalog' || source.config.answerEnabled)) { valid=true;break; }
          }
          if(!valid || await containsPrivateSupplierIdentity(fact.text)) retain=false;
        }
        return { ...original, productNameLookup: lookup, content: retain ? original.content : productNameLookupReply((original.inquiryState.designation || original.inquiryState.model || original.inquiryState.researchSubject)!, lookup) };
      }
      if (original.salesState) {
        const selection = original.selection
          ? {
              ...original.selection,
              candidates: original.selection.candidates.map((c) => ({
                ...c,
                sourcing: publicSourcing(c.sourcing, settings.flags),
              })),
            }
          : undefined;
        if (original.salesState.registeredRevision !== registeredRevision)
          return {
            ...original,
            selection: undefined,
            sourcing: undefined,
            handoff: undefined,
            content:
              '登録情報が更新されています。条件・型番・在庫を再確認してから見積依頼へ進みます。',
          };
        const sourcing = original.sourcing
          ? publicSourcing(original.sourcing, settings.flags)
          : undefined;
        return {
          ...original,
          selection,
          sourcing,
          ...(!settings.flags.quoteRequests ? { handoff: undefined } : {}),
          content:
            original.salesState.stage === 'candidates' && selection
              ? selectionReply(selection, settings.flags)
              : original.salesState.stage === 'quote_offer' && sourcing
                ? `${sourcingReply(sourcing, true)}\nこの型番でお見積りしますか？`
                : original.content,
        };
      }
      const m = original.sourcing
        ? { ...original, sourcing: publicSourcing(original.sourcing, settings.flags) }
        : original;
      if (
        m.sourcing &&
        !m.estimate &&
        original.groundingHash !==
          groundingHash(m.products, m.knowledge, m.evidence, settings.flags, sourceContext)
      )
        return { ...m, content: sourcingReply(m.sourcing, !!m.requestedQuantity) };
      if (m.estimate && m.sourcing) {
        const latest = await sourcingEstimate(
          id,
          m.sourcing,
          m.estimate.quantity,
          m.estimate.destination,
          settings,
        );
        const valid =
          latest.estimate &&
          latest.revision === m.estimateRevision &&
          Date.parse(m.estimate.validUntil) > Date.now();
        const { estimateRevision: _privateRevision, ...publicMessage } = m;
        return valid
          ? publicMessage
          : {
              ...publicMessage,
              estimate: undefined,
              content: `「${m.sourcing.model}」の概算条件が更新されたか、有効期限を過ぎました。最新の価格・送料・納期を確認するため、もう一度ご質問ください。`,
              handoffDraft: `「${m.sourcing.model}」${m.estimate.quantity}個・${m.estimate.destination}への価格・送料・納期の再確認をお願いします。`,
            };
      }
      const knowledge = m.knowledge
        ? { ...m.knowledge, fields: m.knowledge.fields.filter((f) => fields.includes(f)) }
        : undefined;
      const products = (
        await asyncMap(
          (
            await asyncMap(m.products || [], async (p) => await byId<Product>('products', p.id))
          ).filter((p): p is Product => !!p),
          publicProduct,
        )
      ).filter((p): p is Product => !!p);
      const evidence = await asyncFilter(m.evidence || [], async (e) => {
        const source = e.sourceId ? await byId<Source>('sources', e.sourceId) : undefined;
        if (
          e.visibility !== 'public' ||
          (e.sourceId && !source?.enabled) ||
          (source?.visibility === 'internal' &&
            (e.url || !['社内資料の関連情報', '社内確認済み情報'].includes(e.title)))
        )
          return false;
        if (e.id) {
          const document = await byId<{ createdAt: string }>('documents', e.id);
          if (!document || document.createdAt !== e.retrievedAt) return false;
        }
        return (
          !(await privateSupplierQuestion([e.title, e.excerpt].join(' '))) &&
          !(await containsPrivateSupplierIdentity(e.url || ''))
        );
      });
      // Generated text and replies built from this conversation are kept only
      // while the facts they relied on are unchanged.
      const contextual = m.composed || (m.responseProvider && m.responseProvider !== 'local');
      const stillValid =
        contextual &&
        m.groundingHash ===
          groundingHash(products, knowledge, evidence, settings.flags, sourceContext);
      return {
        ...m,
        // Rebuild factual replies against today's permissions and facts, including
        // when a source is disabled or price/stock visibility changes after a turn.
        content: stillValid
          ? m.content
          : m.role === 'assistant' && knowledge && m.intent !== 'general'
            ? await knowledgeReply(knowledge, settings, m.factualIntents)
            : m.role === 'assistant' &&
                m.products?.length &&
                m.intent &&
                (m.factualIntents?.length || !['general', 'custom'].includes(m.intent))
              ? factualReply(
                  products || [],
                  m.factualIntents || [],
                  m.intent,
                  settings,
                  m.requestedQuantity,
                  m.factDetail,
                )
              : contextual
                ? '現在の登録情報が更新されているため、もう一度ご質問ください。最新の情報でご案内します。'
                : m.content,
        ...(contextual && !stillValid && sourceContext && m.handoffDraft
          ? { handoffDraft: '現在の販売条件で、価格・送料・納期の再確認をお願いします。' }
          : {}),
        knowledge,
        products,
        evidence,
      };
    },
  );
}

function matchCatalog(message: string, intent: QueryIntent, catalog: Product[]): Product[] {
  let matches: Product[] = [];
  const query = normalize(message);
  if (intent.model) {
    matches = catalog.filter((p) => normalize(p.model) === normalize(intent.model!));
    const branded = matches.filter(
      (p) => p.manufacturer && query.includes(normalize(p.manufacturer)),
    );
    if (branded.length) matches = branded;
  } else {
    const candidates = catalog.map((p) => {
      const name = normalize(p.name.replace(/（確認用）/g, ''));
      const named =
        ['耐熱ガラス', 'ガラス', '炉内金物', 'スタッド', '鋳物', 'ダクト', '台車'].some(
          (word) => p.name.includes(word) && query.includes(normalize(word)),
        ) ||
        (p.name.includes('炉内金物') && /工業炉|炉の部品/.test(message));
      const category = p.category
        .split('・')
        .some((word) => word.length > 1 && query.includes(normalize(word)));
      return { p, score: name && query.includes(name) ? 10 : named ? 5 : category ? 1 : 0 };
    });
    // A broad category must not add castings to a specific glass query when
    // named product matches already exist.
    const namedMatches = candidates.some((c) => c.score >= 5);
    matches = candidates
      .filter((x) => x.score >= (namedMatches ? 5 : 1))
      .sort((a, b) => b.score - a.score)
      .slice(0, 4)
      .map((x) => x.p);
  }
  return matches;
}
