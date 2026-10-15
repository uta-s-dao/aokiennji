import { NextRequest, NextResponse, after } from 'next/server';
import { z } from 'zod';
import type {
  AppSettings,
  AuditEvent,
  Conversation,
  Inquiry,
  Order,
  Product,
  Quote,
  Source,
  SourceRun,
  Supplier,
  SupplierKnowledge,
} from '@/lib/contracts';
import {
  db,
  list,
  byId,
  save,
  audit,
  uid,
  now,
  normalize,
  productIdentity,
  getSettings,
  putSettings,
  demoMode,
} from '@/lib/server/db';
import {
  ApiError,
  requireAdmin,
  anonOwner,
  setSession,
  clearAdmin,
  checkOrigin,
  verifyPassword,
  rateLimit,
  clientKey,
} from '@/lib/server/auth';
import {
  acceptQuote,
  approveOrder,
  conversationMessages,
  createQuote,
  customerQuote,
  dispatchOrder,
  getPublicProduct,
  getQuoteByToken,
  handOff,
  overview,
  publicProducts,
  requireFlag,
  updateQuote,
  validProduct,
  validateSettings,
  verifyConversation,
} from '@/lib/server/business';
import { answerChat, currentMessages } from '@/lib/server/chat';
import { commitPreview, previewUpload, sourceById, syncSource } from '@/lib/server/ingestion';
import { aiProviderStatuses, checkAiProvider } from '@/lib/server/ai-setup';
import { aiUsageReport } from '@/lib/server/ai-usage';
import { aiAnswerReport } from '@/lib/server/ai-answer-history';
import { researchNotes } from '@/lib/server/research';
import { updateProcurementOffer } from '@/lib/server/sourcing-estimate';
import {
  inquirySchema,
  productSchema,
  quoteRequestSchema,
  quoteUpdateSchema,
  settingsSchema,
  sourceSchema,
  supplierSchema,
} from '@/lib/server/validation';
import { validateExternalUrl } from '@/lib/server/safe-fetch';
import { responseBudgets } from '@/lib/server/response-transport';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const ok = (data: unknown, status = 200) =>
  NextResponse.json({ data }, { status, headers: { 'Cache-Control': 'no-store' } });
async function body(req: NextRequest) {
  if (Number(req.headers.get('content-length')) > 1000000)
    throw new ApiError(413, 'too_large', '入力が大きすぎます');
  const text = await req.text();
  if (Buffer.byteLength(text) > 1000000) throw new ApiError(413, 'too_large', '入力が大きすぎます');
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'invalid_json', '入力形式を確認してください');
  }
}
function found<T>(table: string, id: string): T {
  const x = byId<T>(table, id);
  if (!x) throw new ApiError(404, 'not_found', 'データが見つかりません');
  return x;
}
function publicOrder(o: Order): Order {
  return { ...o, supplierId: null, externalId: null, lastError: null };
}
async function handle(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  try {
    const p = (await context.params).path;
    const path = p.join('/');
    const method = req.method;
    if (method !== 'GET') checkOrigin(req);
    if (p[0] === 'admin') requireAdmin(req);
    if (path === 'config' && method === 'GET') {
      const s = getSettings();
      return ok({ flags: s.flags, demoMode: demoMode(), welcomeMessage: s.welcomeMessage });
    }
    if (path === 'auth/login' && method === 'POST') {
      rateLimit(`login:${clientKey(req)}`, 15, 15 * 60000);
      const { password } = z
        .object({ password: z.string().min(1).max(300) })
        .parse(await body(req));
      const hash = process.env.ADMIN_PASSWORD_HASH;
      if (!hash) throw new ApiError(503, 'setup_required', '管理者の初期設定が必要です');
      if (!verifyPassword(password, hash))
        throw new ApiError(401, 'invalid_login', 'パスワードを確認してください');
      const res = ok({ authenticated: true });
      setSession(res, 'admin');
      return res;
    }
    if (path === 'auth/logout' && method === 'POST') {
      const res = ok({ authenticated: false });
      clearAdmin(req, res);
      return res;
    }
    if (path === 'products' && method === 'GET')
      return ok(
        publicProducts(
          req.nextUrl.searchParams.get('q') || '',
          req.nextUrl.searchParams.get('category') || '',
        ),
      );
    if (p[0] === 'products' && p.length === 2 && method === 'GET')
      return ok(getPublicProduct(p[1]));
    if (path === 'chat' && method === 'POST') {
      requireFlag('chat');
      rateLimit(`chat:${clientKey(req)}`, 90, 60000);
      const input = z
        .object({
          message: z.string().trim().min(1).max(2000),
          conversationId: z.string().max(100).optional(),
        })
        .parse(await body(req));
      const cookieResponse = ok(null);
      let owner = anonOwner(req);
      if (!owner) owner = setSession(cookieResponse, 'anon');
      if (input.conversationId) verifyConversation(input.conversationId, owner);
      if (req.headers.get('accept')?.includes('text/event-stream')) {
        const encoder = new TextEncoder();
        const controller = new AbortController();
        const signal = AbortSignal.any([
          req.signal,
          controller.signal,
          AbortSignal.timeout(responseBudgets(getSettings().flags.webSearch).chat),
        ]);
        const stream = new ReadableStream<Uint8Array>({
          async start(streamController) {
            const send = (type: string, data: unknown) => {
              if (!controller.signal.aborted)
                streamController.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ type, data })}\n\n`),
                );
            };
            try {
              send('status', 'ご相談内容を確認しています');
              const result = await answerChat(input.message, owner!, input.conversationId, {
                onText: (text) => send('text', text),
                signal,
                defer: (work) => after(work),
              });
              send('result', result);
            } catch {
              send('error', '回答を完了できませんでした。もう一度お試しください。');
            } finally {
              if (!controller.signal.aborted) streamController.close();
            }
          },
          cancel() {
            controller.abort();
          },
        });
        const response = new NextResponse(stream, {
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'X-Accel-Buffering': 'no',
          },
        });
        for (const cookie of cookieResponse.cookies.getAll()) response.cookies.set(cookie);
        return response;
      }
      const result = await answerChat(input.message, owner, input.conversationId, {
        defer: (work) => after(work),
      });
      const response = ok(result);
      for (const cookie of cookieResponse.cookies.getAll()) response.cookies.set(cookie);
      return response;
    }
    if (p[0] === 'chat' && p.length === 2 && method === 'GET') {
      requireFlag('chat');
      return ok({
        conversation: verifyConversation(p[1], anonOwner(req)),
        messages: currentMessages(p[1]),
      });
    }
    if (path === 'inquiries' && method === 'POST') {
      requireFlag('humanHandoff');
      rateLimit(`inquiry:${clientKey(req)}`, 30, 60000);
      const input = inquirySchema.parse(await body(req));
      if (input.conversationId) handOff(verifyConversation(input.conversationId, anonOwner(req)));
      const inquiry: Inquiry = { ...input, id: uid(), status: 'new', notes: '', createdAt: now() };
      save('inquiries', inquiry);
      audit('inquiry.created', inquiry.id, '担当者への相談を受け付けました');
      return ok(inquiry, 201);
    }
    if (path === 'quotes' && method === 'POST') {
      requireFlag('quoteRequests');
      rateLimit(`quote:${clientKey(req)}`, 30, 60000);
      return ok(createQuote(quoteRequestSchema.parse(await body(req)), anonOwner(req)), 201);
    }
    if (p[0] === 'quotes' && p.length === 2 && method === 'GET')
      return ok(customerQuote(getQuoteByToken(p[1])));
    if (p[0] === 'quotes' && p[2] === 'accept' && p.length === 3 && method === 'POST') {
      const input = z
        .object({ confirmed: z.literal(true), idempotencyKey: z.string().min(8).max(128) })
        .parse(await body(req));
      let order = acceptQuote(p[1], input.confirmed, input.idempotencyKey);
      const s = getSettings();
      if (
        s.flags.autoOrder &&
        order.status === 'pending_approval' &&
        order.total <= s.maxAutoOrderAmount &&
        order.supplierId
      ) {
        const supplier = byId<Supplier>('suppliers', order.supplierId);
        const quote = found<Quote>('quotes', order.quoteId);
        if (
          supplier?.enabled &&
          supplier.approved &&
          quote.lines.every((l) => {
            const product = l.productId ? byId<Product>('products', l.productId) : null;
            return product && validProduct(product) && product.supplierId === supplier.id;
          })
        ) {
          order = approveOrder(order.id);
          if (demoMode() || process.env.ALLOW_LIVE_ORDERS === 'true')
            order = await dispatchOrder(order.id);
        }
      }
      return ok(publicOrder(order));
    }
    if (path === 'admin/overview' && method === 'GET') return ok(overview());
    if (path === 'admin/settings') {
      if (method === 'GET') return ok(getSettings());
      if (method === 'PUT') {
        const value = settingsSchema.parse(await body(req));
        validateSettings(value);
        putSettings(value);
        audit('settings.updated', 'settings', '機能設定を更新しました');
        return ok(value);
      }
    }
    if (path === 'admin/providers' && method === 'GET') return ok(aiProviderStatuses());
    if (path === 'admin/ai-answers' && method === 'GET') {
      const filters = z
        .object({
          provider: z.enum(['openai', 'jev', 'gemini', 'local']).optional(),
          since: z.iso.datetime().optional(),
          until: z.iso.datetime().optional(),
          conversationId: z.string().max(100).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        })
        .parse(Object.fromEntries(req.nextUrl.searchParams));
      return ok(aiAnswerReport(filters));
    }
    if (path === 'admin/ai-usage' && method === 'GET') {
      const filters = z
        .object({
          provider: z.enum(['openai', 'jev', 'gemini']).optional(),
          scope: z.enum(['chat', 'connection_check', 'standalone']).optional(),
          since: z.iso.datetime().optional(),
          until: z.iso.datetime().optional(),
          conversationId: z.string().max(100).optional(),
          turnId: z.string().max(100).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        })
        .parse(Object.fromEntries(req.nextUrl.searchParams));
      return ok(aiUsageReport(filters));
    }
    if (
      p[0] === 'admin' &&
      p[1] === 'providers' &&
      p[3] === 'test' &&
      p.length === 4 &&
      method === 'POST'
    ) {
      const id = z.enum(['openai', 'jev', 'gemini', 'exa', 'tavily']).parse(p[2]);
      rateLimit(`provider-test:${clientKey(req)}`, 10, 60000);
      const check = await checkAiProvider(id);
      audit('provider.checked', id, check.ok ? '接続確認成功' : '接続未完了');
      return ok(check);
    }
    if (path === 'admin/audit' && method === 'GET')
      return ok(list<AuditEvent>('audit_events').toReversed().slice(0, 300));
    if (p[0] === 'admin' && p[1] === 'products') {
      if (method === 'GET' && p.length === 2) return ok(list<Product>('products'));
      if (method === 'POST' || method === 'PUT') {
        const input = productSchema.parse(await body(req));
        const old = method === 'PUT' ? found<Product>('products', p[2]) : undefined;
        if (input.sourceId) sourceById(input.sourceId);
        else {
          const id = 'manual-catalog';
          if (!byId('sources', id))
            save('sources', {
              id,
              name: '社内商品台帳',
              kind: 'manual',
              url: '',
              enabled: true,
              trust: 'internal',
              visibility: 'internal',
              syncIntervalHours: 0,
              config: {},
              recordCount: 0,
              lastSyncedAt: null,
              lastError: null,
              createdAt: now(),
            });
          input.sourceId = id;
        }
        if (input.supplierId) found<Supplier>('suppliers', input.supplierId);
        const product: Product = {
          ...input,
          id: old?.id || uid(),
          createdAt: old?.createdAt || now(),
          updatedAt: now(),
        };
        save('products', product, {
          source_id: product.sourceId,
          supplier_id: product.supplierId,
          model_key: productIdentity(product),
        });
        audit('product.saved', product.id, '商品を保存しました');
        return ok(product);
      }
      if (method === 'DELETE' && p.length === 3) {
        found<Product>('products', p[2]);
        db().prepare('DELETE FROM products WHERE id=?').run(p[2]);
        audit('product.deleted', p[2], '商品を削除しました');
        return ok({ deleted: true });
      }
    }
    if (p[0] === 'admin' && p[1] === 'sources') {
      if (method === 'GET' && p.length === 2) return ok(list<Source>('sources'));
      if (p[3] === 'knowledge' && p.length === 4 && method === 'GET') {
        sourceById(p[2]);
        return ok(list<SupplierKnowledge>('supplier_knowledge').filter((r) => r.sourceId === p[2]));
      }
      if (p[3] === 'runs' && method === 'GET')
        return ok(
          list<SourceRun>('source_runs')
            .filter((x) => x.sourceId === p[2])
            .toReversed(),
        );
      if (p[3] === 'sync' && method === 'POST') return ok(await syncSource(p[2]));
      if ((method === 'POST' && p.length === 2) || (method === 'PUT' && p.length === 3)) {
        const input = sourceSchema.parse(await body(req));
        if (input.url) validateExternalUrl(input.url);
        const old = method === 'PUT' ? sourceById(p[2]) : undefined;
        if (
          old &&
          old.kind !== input.kind &&
          (old.kind === 'supplier_catalog' || input.kind === 'supplier_catalog')
        )
          throw new ApiError(
            400,
            'source_kind_locked',
            '仕入先一覧への種類変更はできません。新しい情報源を追加してください',
          );
        if (input.kind === 'supplier_catalog') {
          input.visibility = 'internal';
          input.url = '';
          input.syncIntervalHours = 0;
        }
        const source: Source = {
          ...input,
          id: old?.id || uid(),
          lastSyncedAt: old?.lastSyncedAt || null,
          lastError: old?.lastError || null,
          recordCount: old?.recordCount || 0,
          createdAt: old?.createdAt || now(),
        };
        save('sources', source);
        audit('source.saved', source.id, '情報源を保存しました');
        return ok(source);
      }
      if (method === 'DELETE' && p.length === 3) {
        const s = sourceById(p[2]);
        save('sources', { ...s, enabled: false });
        audit('source.disabled', s.id, '情報源を無効にしました');
        return ok({ deleted: true });
      }
    }
    if (path === 'admin/import/preview' && method === 'POST') {
      if (Number(req.headers.get('content-length')) > 11 * 1024 * 1024)
        throw new ApiError(413, 'too_large', 'ファイルは10MB以下にしてください');
      const form = await req.formData();
      const file = form.get('file'),
        sourceId = form.get('sourceId');
      if (!(file instanceof File) || typeof sourceId !== 'string')
        throw new ApiError(400, 'invalid_upload', 'ファイルと情報源を指定してください');
      if (file.size > 10 * 1024 * 1024)
        throw new ApiError(413, 'too_large', 'ファイルは10MB以下にしてください');
      return ok(await previewUpload(sourceId, file.name, Buffer.from(await file.arrayBuffer())));
    }
    if (path === 'admin/import/commit' && method === 'POST') {
      const value = z
        .object({
          previewId: z.string(),
          mapping: z.record(z.string(), z.string()),
          approved: z.boolean(),
        })
        .parse(await body(req));
      return ok(commitPreview(value.previewId, value.mapping, value.approved));
    }
    if (p[0] === 'admin' && p[1] === 'suppliers') {
      if (method === 'GET') return ok(list<Supplier>('suppliers'));
      if (method === 'POST' || method === 'PUT') {
        const input = supplierSchema.parse(await body(req));
        if (input.orderEndpoint) validateExternalUrl(input.orderEndpoint, true);
        const old = method === 'PUT' ? found<Supplier>('suppliers', p[2]) : undefined;
        const supplier: Supplier = {
          ...input,
          id: old?.id || uid(),
          createdAt: old?.createdAt || now(),
        };
        save('suppliers', supplier);
        audit('supplier.saved', supplier.id, '仕入先を保存しました');
        return ok(supplier);
      }
    }
    if (
      p[0] === 'admin' &&
      p[1] === 'conversations' &&
      p.length === 7 &&
      p[3] === 'research' &&
      p[5] === 'offers' &&
      method === 'PUT'
    ) {
      return ok(updateProcurementOffer(p[2], p[4], p[6], await body(req)));
    }
    if (p[0] === 'admin' && p[1] === 'conversations' && method === 'GET') {
      if (p.length === 2)
        return ok(
          list<Conversation>('conversations').sort((a, b) =>
            b.updatedAt.localeCompare(a.updatedAt),
          ),
        );
      return ok({
        conversation: found<Conversation>('conversations', p[2]),
        messages: conversationMessages(p[2]),
        research: researchNotes(p[2]),
        answers: aiAnswerReport({ conversationId: p[2], limit: 500 }).items,
      });
    }
    if (p[0] === 'admin' && p[1] === 'inquiries') {
      if (method === 'GET') return ok(list<Inquiry>('inquiries').toReversed());
      if (method === 'PUT') {
        const input = z
          .object({
            status: z.enum(['new', 'in_progress', 'resolved']),
            notes: z.string().max(5000),
          })
          .parse(await body(req));
        const inquiry = { ...found<Inquiry>('inquiries', p[2]), ...input };
        save('inquiries', inquiry);
        audit('inquiry.updated', inquiry.id, '相談の対応状況を更新しました');
        return ok(inquiry);
      }
    }
    if (p[0] === 'admin' && p[1] === 'quotes') {
      if (method === 'GET') return ok(list<Quote>('quotes').toReversed());
      if (method === 'PUT') return ok(updateQuote(p[2], quoteUpdateSchema.parse(await body(req))));
    }
    if (p[0] === 'admin' && p[1] === 'orders') {
      if (method === 'GET') return ok(list<Order>('orders').toReversed());
      if (method === 'POST' && p[3] === 'approve') return ok(approveOrder(p[2]));
      if (method === 'POST' && p[3] === 'dispatch') return ok(await dispatchOrder(p[2]));
    }
    throw new ApiError(404, 'not_found', 'ページが見つかりません');
  } catch (e) {
    if (e instanceof ApiError)
      return NextResponse.json(
        { error: { code: e.code, message: e.message } },
        { status: e.status },
      );
    if (e instanceof z.ZodError)
      return NextResponse.json(
        {
          error: {
            code: 'validation_error',
            message: `入力を確認してください: ${e.issues
              .slice(0, 3)
              .map((i) => `${i.path.join('.')} ${i.message}`)
              .join(' / ')}`,
          },
        },
        { status: 400 },
      );
    if ((e as { code?: string })?.code?.startsWith('SQLITE_CONSTRAINT'))
      return NextResponse.json(
        {
          error: {
            code: 'conflict',
            message: '同じ型番のデータがあるか、更新条件を満たしていません',
          },
        },
        { status: 409 },
      );
    console.error('API error', e instanceof Error ? e.message : 'unknown');
    return NextResponse.json(
      {
        error: {
          code: 'internal_error',
          message: '処理に失敗しました。内容を確認して再度お試しください',
        },
      },
      { status: 500 },
    );
  }
}
export { handle as GET, handle as POST, handle as PUT, handle as DELETE };
