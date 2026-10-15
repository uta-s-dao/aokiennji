import type {
  ChatMessage,
  ChatResponse,
  ResearchAspect,
  Conversation,
  Evidence,
  Product,
  QueryIntent,
  Source,
  Supplier,
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
import { classifyQuery, localIntent, searchWeb } from './providers';
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
    onText?: (text: string) => void;
    signal?: AbortSignal;
    // Runs work after the reply is sent, such as research for the staff.
    defer?: (work: () => Promise<void>) => void;
  } = {},
): Promise<ChatResponse> {
  requireFlag('chat');
  const userCreatedAt = now();
  const settings = getSettings();
  output = {
    ...output,
    signal: output.signal || AbortSignal.timeout(responseBudgets(settings.flags.webSearch).chat),
  };
  const conversation: Conversation = conversationId
    ? verifyConversation(conversationId, owner)
    : {
        id: uid(),
        title: message.slice(0, 60),
        status: 'open',
        createdAt: userCreatedAt,
        updatedAt: now(),
      };
  const previous = conversationId ? currentMessages(conversation.id) : [];
  const usageContext = { scope: 'chat' as const, conversationId: conversation.id, turnId: uid() };
  // Record receipt before any external service runs. An interrupted reply must
  // not erase the customer's question or the conversation from the admin list.
  db().transaction(() => {
    save('conversations', { ...conversation, updatedAt: userCreatedAt }, { owner_id: owner });
    save(
      'messages',
      {
        id: usageContext.turnId,
        conversationId: conversation.id,
        role: 'user',
        content: message,
        createdAt: userCreatedAt,
      },
      { conversation_id: conversation.id },
    );
    if (!conversationId) audit('conversation.created', conversation.id, '商品相談を受け付けました');
  })();
  const assistantId = uid();
  const onText = output.onText;
  if (onText) {
    output.onText = (content) => {
      // Keep the latest text offered to the stream, even if delivery fails.
      // Completion replaces this same row, without duplicating the reply.
      if (content.trim())
        save(
          'messages',
          {
            id: assistantId,
            conversationId: conversation.id,
            role: 'assistant',
            replyToId: usageContext.turnId,
            content,
            incomplete: true,
            createdAt: now(),
          },
          { conversation_id: conversation.id },
        );
      onText(content);
    };
  }
  const privateQuestion = privateSupplierQuestion(message);
  const safeHistory = previous.filter((m) => !privateSupplierQuestion(m.content));
  // The customer's own words, oldest first: conditions to keep and summarize.
  const customerTexts = [
    ...safeHistory.filter((m) => m.role === 'user').map((m) => m.content),
    ...(privateQuestion ? [] : [message]),
  ];
  const request = stripCourtesy(message) || message.normalize('NFKC').trim();
  const local = localIntent(message);
  const catalog = publicProducts();
  const lastReply = previous.toReversed().find((m) => m.role === 'assistant');
  const localMatches = matchCatalog(message, local, catalog);
  const localTopic = knowledgeTopic(message, local, lastReply);
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
      : documentCandidates(message, local);
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
  const webWork = shouldSearchWeb
    ? searchWeb(
        message,
        settings,
        list<Supplier>('suppliers')
          .filter((s) => s.enabled && s.approved)
          .flatMap((s) => s.domains),
      )
        .then((data) => ({ data, failed: false }))
        .catch(() => ({ data: [] as Evidence[], failed: true }))
    : Promise.resolve({ data: [] as Evidence[], failed: false });
  const intent = !planned.classify
    ? local
    : await classifyQuery(message, settings, safeHistory, {
        fields: availableFields(),
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
  let requestedQuantity =
    statedQuantity || (continued ? continuedFrom?.requestedQuantity : undefined);
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
  let topic = knowledgeTopic(message, intent, last);
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
    (!namedTopic &&
    (sourcingFollowup || intent.referencesPrevious || quantityFollowup || isBareReply(message))
      ? lastReply?.sourcing?.model
      : undefined);
  const sourcing =
    !privateQuestion &&
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
        })
      : undefined;
  // Keep conditions only from the current sourced item, including later quantity/destination turns.
  const sameSource =
    sourceModel &&
    lastReply?.sourcing &&
    normalize(lastReply.sourcing.model) === normalize(sourceModel);
  if (sourcing)
    requestedQuantity = statedQuantity || (sameSource ? lastReply?.requestedQuantity : undefined);
  const sourceDestination = sourcing
    ? destinationIn([message]) || (sameSource ? lastReply?.requestedDestination : undefined)
    : undefined;
  const estimateResult = sourcing
    ? sourcingEstimate(conversation.id, sourcing, requestedQuantity, sourceDestination, settings)
    : undefined;
  const sourcedReply = () => {
    if (estimateResult?.estimate) return estimateReply(estimateResult.estimate);
    const text = sourcingReply(sourcing!, !!requestedQuantity);
    if (!requestedQuantity) return text;
    if (!sourceDestination) return `${text}\nお届け先の都道府県を教えていただけますか？`;
    if (
      settings.sourcingEstimate.enabled &&
      settings.flags.showPrice &&
      settings.flags.showLeadTime
    ) {
      const missing = estimateResult?.missing || [];
      const packs = missing.find((m) => m.startsWith('入数に合う数量'));
      if (packs)
        return `${text}\nこちらは${packs.match(/（(.+)）/)?.[1] || '梱包単位'}での販売です。ご希望の数量をご指定ください。`;
      const pending = [
        ...new Set(
          missing.map((m) =>
            /送料/.test(m)
              ? '送料'
              : /営業日/.test(m)
                ? '納期'
                : /配送条件/.test(m)
                  ? `${sourceDestination}への配送条件`
                  : /調達可否/.test(m)
                    ? 'ご希望数量の在庫'
                    : '販売価格・販売単位',
          ),
        ),
      ];
      return `${text}\n${sourceDestination}への${requestedQuantity}個のお届けについて、${pending.join('・')}を確認中です。未確認の金額や日数は、確認でき次第ご案内します。`;
    }
    return text;
  };
  if (sourcing) {
    topic = undefined;
    route.reason = 'sourcing';
    route.response = 'local';
  }
  const evidence: Evidence[] = matches.flatMap((p) => p.evidence || []);
  let externalWarning = '';
  const external = await webWork;
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
      ...external.data.filter(
        (e) =>
          !privateSupplierQuestion([e.title, e.excerpt].join(' ')) &&
          !containsPrivateSupplierIdentity(e.url || ''),
      ),
    );
  }

  const handedOff = conversation.status === 'handed_off';
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
  const quoteOffered = previous.some((m) => m.role === 'assistant' && m.handoff === 'quote');
  const quoteProduct =
    matches.length === 1 && ['available', 'orderable'].includes(matches[0].availability)
      ? matches[0]
      : undefined;
  const offered =
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
          ? `「${intent.model}」は登録商品にはありませんが、お取り寄せを含めて担当者が確認します。`
          : undefined,
    previousReplies: safeHistory.filter((m) => m.role === 'assistant').map((m) => m.content),
    handoff: (settings.flags.humanHandoff || handoff === 'quote') && !handedOff,
    guideLabel: guide.label,
    phone,
    destination: destinationIn(customerTexts),
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
    const lead = `「${intent.model}」は登録商品にはありませんが、${asked ? `${asked}も含めて、` : ''}お取り寄せできるか担当者が確認します。`;
    // Only the amount is asked for; a maker named in another way ("バンドーの
    // レッドS-II") was asked for again.
    const counted = customerTexts.some((t) => /\d+\s*(?:個|台|枚|本|セット|巻|pcs)/i.test(t));
    return route.response === 'local' && !counted
      ? `${lead}\n必要な数量を教えていただけますか？`
      : lead;
  };
  const facts = () =>
    topic
      ? knowledgeReply(topic, settings, route.facts)
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
          ? '関連する資料・候補が見つかりました。資料の記載だけでは販売・取り寄せ可否を確定できないため、担当者の確認が必要です。'
          : intent.model
            ? unknownModel()
            : // An item already described is not asked for again.
              customerTopic
              ? unregisteredFacts()
              : missingProductReply(intent.intent);
  // The fixed part a reply starts with; empty when the whole reply is a
  // conversation written by the response model. With repeat, sentences given
  // earlier in the conversation are kept (used when nothing else can answer).
  const fixedPart = (repeat: boolean) => {
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
                ? `ここまでの内容で担当者に相談される場合は、下の「${guide.label}」から送れます。`
                : 'ほかに確認したいことがあれば、そのまま続けてお聞きください。'
            }`
          : introduction
        : topic
          ? knowledgeReply(topic, settings)
          : introduction;
    if (route.reason === 'policy')
      return join(
        policy,
        route.facts.length
          ? matches.length
            ? facts()
            : statement(topic ? facts() : unregisteredFacts())
          : '',
      );
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
        ? facts()
        : intent.model && !topic && !repeat && modelSaid
          ? ''
          : statement(facts()),
      policy,
    );
    // A field has no registered values, so the next step comes from the
    // conversation instead of a request for a model number.
    return route.reason === 'facts' && route.response === 'local' && topic?.mode === 'fields'
      ? join(answer, once(composeConsultation(compose, 'next')))
      : answer;
  };
  let fixed = fixedPart(false);
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
  if (sourcing && !fixed.trim()) fixed = sourcedReply();
  const repeated = !fixed.trim() && route.response !== 'ai';
  // Taken before the route changes: the fixed answer given again is what the
  // response model restates, and what is shown if it cannot answer.
  const givenBefore = repeated ? fixedPart(true) : '';
  if (repeated) {
    if (aiReady && !['privacy', 'social'].includes(route.reason)) route.response = 'ai';
    else fixed = givenBefore;
    composed = true;
  }
  fixed += externalWarning;
  const rules =
    topic?.mode === 'fields'
      ? `「${topic.fields.join('」「')}」は相談を受け付けている取扱分野です。個別製品の仕様・対応可否、価格・在庫・納期は担当者が確認します。`
      : matches.length === 1
        ? `「${matches[0].name}」（型番${matches[0].model}）は登録商品です。${
            matches[0].isDemo ? '確認用のデモデータで、実際の販売条件ではありません。' : ''
          }${
            matches[0].availability === 'needs_review'
              ? '現在の取扱条件は担当者が確認中です。'
              : matches[0].availability === 'unavailable'
                ? '現在は取扱対象外として登録されています。'
                : ''
          }用途への適合や個別の対応可否は担当者が確認します。`
        : matches.length > 1
          ? `候補の登録商品: ${matches.map((p) => `「${p.name}」`).join('')}。どの商品かはお客様に確認が必要です。`
          : evidence.length
            ? '関連する資料・候補があります。資料の記載だけでは販売・取り寄せ可否を確定できないため、担当者の確認が必要です。'
            : intent.model
              ? `「${intent.model}」は登録商品ではありません。取り寄せの可否・価格・在庫・納期は担当者が確認します。取扱いがないとは言わない。`
              : intent.intent === 'custom'
                ? '図面や仕様をもとに、設計・製作のご相談を承ります。製作可否・価格・納期は担当者が確認します。'
                : '個別製品の対応可否・価格・在庫・納期は担当者が確認します。';
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
  const fallback = repeated
    ? givenBefore
    : route.reason === 'handoff'
      ? conditions.length
        ? `伺った条件（${conditions.join('・')}）も、この会話と一緒に担当者へ引き継がれます。`
        : ''
      : route.reason === 'policy'
        ? policyNext
        : route.response === 'mixed'
          ? composeConsultation({ ...compose, guided: fixed.includes(guide.label) }, 'next')
          : route.reason === 'summary'
            ? summarizeConsultation(compose)
            : intent.intent === 'general' || (topic?.mode === 'fields' && topic.fields.length > 2)
              ? topic
                ? knowledgeReply(topic, settings)
                : introduction
              : composeConsultation({
                  ...compose,
                  lead: [demoNotice, compose.lead].filter(Boolean).join('\n') || undefined,
                });
  const fields = availableFields();
  if (route.response === 'mixed') output.onText?.(fixed);
  const generated =
    route.response !== 'local'
      ? await generateGroundedReply(
          {
            question: message,
            history: safeHistory,
            customerNotes: customerTexts,
            mode:
              route.reason === 'summary'
                ? 'summary'
                : route.response === 'mixed'
                  ? 'supplement'
                  : 'consult',
            canonical: route.response === 'mixed' ? fixed : rules,
            ...(repeated && givenBefore ? { answer: givenBefore } : {}),
            // Without the model, sentences given earlier are not repeated either.
            fallback: route.reason === 'summary' ? fallback : unsaid(fallback, said) || fallback,
            settings,
            facts: [
              { id: 'business_rules', text: rules },
              ...matches.map((p, i) => ({
                id: `product_${i}`,
                text: JSON.stringify({
                  name: p.name,
                  model: p.model,
                  description:
                    p.approved && !privateSupplierQuestion(p.description) ? p.description : '',
                  specifications:
                    p.approved && !privateSupplierQuestion(p.specifications)
                      ? p.specifications
                      : '',
                }),
              })),
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
                  ? 'この会話は担当者へのご相談として受付済みです。担当者が内容を確認して連絡します。'
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
            // A rejected draft is rewritten only while the reply can still
            // finish within the response time budget.
            retryUntil: Date.parse(userCreatedAt) + responseBudgets().retry,
            signal: AbortSignal.any([
              output.signal!,
              AbortSignal.timeout(
                Math.max(
                  100,
                  responseBudgets().generation - (Date.now() - Date.parse(userCreatedAt)),
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
        ? [fixed, generated.content].filter(Boolean).join('\n\n')
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
      finish(givenBefore || fixedPart(true)) ||
      finish(composeConsultation(compose, 'next')) ||
      'ご相談の内容は、担当者がこの会話を確認してご案内します。';
  if (output.signal?.aborted) throw new Error('処理が中断されました');
  if (estimateResult?.estimate) content = estimateReply(estimateResult.estimate);
  const assistant: ChatMessage = {
    id: assistantId,
    role: 'assistant',
    content,
    ...(sourcing ? { sourcing } : {}),
    ...(estimateResult?.estimate
      ? { estimate: estimateResult.estimate, estimateRevision: estimateResult.revision }
      : {}),
    responseProvider: generated.provider,
    groundingHash: groundingHash(
      matches,
      topic,
      evidence,
      settings.flags,
      sourcingContextRevision(conversation.id, settings),
    ),
    knowledge: topic,
    products: matches,
    evidence,
    intent: intent.intent,
    factualIntents: route.facts,
    requestedQuantity,
    ...(sourceDestination ? { requestedDestination: sourceDestination } : {}),
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
    suggestions: followUps(
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
  db().transaction(() => {
    save(
      'conversations',
      { ...verifyConversation(conversation.id, owner), updatedAt: now() },
      { owner_id: owner },
    );
    save(
      'messages',
      {
        ...assistant,
        conversationId: conversation.id,
        replyToId: usageContext.turnId,
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
    audit(
      'chat.routed',
      conversation.id,
      `振り分け:${CHAT_ROUTE_LABELS[route.reason]} / ${route.reason} / 分類:${intent.provider} / 回答:${generated.provider} / ${generated.reason} / Web:${shouldSearchWeb || sourcing ? '実行' : '省略'} / ${Date.now() - Date.parse(userCreatedAt)}ms`,
    );
  })();
  onText?.(content);
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
    const available = availableFields();
    output.defer(() =>
      researchForStaff(
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
          destination: destinationIn(customerTexts),
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
export function currentMessages(id: string): ChatMessage[] {
  const settings = getSettings();
  const fields = availableFields();
  const sourceContext = sourcingContextRevision(id, settings);
  // Partial replies remain in the staff transcript; only completed replies
  // can be restored publicly or used as context for the next answer.
  return (conversationMessages(id) as StoredChatMessage[])
    .filter((m) => !m.incomplete)
    .map(({ replyToId: _replyToId, processing: _processing, ...message }) => message)
    .map((m) => {
      if (m.estimate && m.sourcing) {
        const latest = sourcingEstimate(
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
      const products = m.products
        ?.map((p) => byId<Product>('products', p.id))
        .filter((p): p is Product => !!p)
        .map(publicProduct)
        .filter((p): p is Product => !!p);
      const evidence = m.evidence?.filter((e) => {
        const source = e.sourceId ? byId<Source>('sources', e.sourceId) : undefined;
        if (
          e.visibility !== 'public' ||
          (e.sourceId && !source?.enabled) ||
          (source?.visibility === 'internal' &&
            (e.url || !['社内資料の関連情報', '社内確認済み情報'].includes(e.title)))
        )
          return false;
        if (e.id) {
          const document = byId<{ createdAt: string }>('documents', e.id);
          if (!document || document.createdAt !== e.retrievedAt) return false;
        }
        return (
          !privateSupplierQuestion([e.title, e.excerpt].join(' ')) &&
          !containsPrivateSupplierIdentity(e.url || '')
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
            ? knowledgeReply(knowledge, settings, m.factualIntents)
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
    });
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
