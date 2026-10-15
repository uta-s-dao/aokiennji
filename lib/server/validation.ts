import { z } from 'zod';
import { DEFAULT_SOURCING_ESTIMATE } from '../contracts';
import { PREFECTURES } from '../sourcing-estimate';
const text = (max = 1000) => z.string().trim().max(max);
const count = z.number().int().min(0).max(1000000000);
export const productSchema = z.object({
  name: text(200).min(1),
  model: text(120),
  manufacturer: text(200),
  category: text(200),
  description: text(10000),
  specifications: text(10000),
  image: text(2000).refine(
    (v) => !v || v.startsWith('/images/') || /^https:\/\//.test(v),
    '画像は公開HTTPS URLを指定してください',
  ),
  availability: z.enum(['available', 'orderable', 'needs_review', 'unavailable']),
  price: count.nullable(),
  stock: count.nullable(),
  leadTime: text(300),
  sourceId: text(100).nullable(),
  supplierId: text(100).nullable(),
  approved: z.boolean(),
  visibility: z.enum(['public', 'internal']),
  verifiedAt: z.string().datetime().nullable(),
  isDemo: z.boolean(),
});
export const sourceSchema = z.object({
  name: text(200).min(1),
  kind: z.enum([
    'manual',
    'csv',
    'xlsx',
    'supplier_catalog',
    'pdf',
    'docx',
    'text',
    'website',
    'csv_url',
    'json_api',
  ]),
  url: text(2000),
  enabled: z.boolean(),
  trust: z.enum(['internal', 'approved_supplier', 'discovery']),
  visibility: z.enum(['public', 'internal']),
  syncIntervalHours: z.number().min(0).max(8760),
  config: z.object({
    answerEnabled: z.boolean().optional(),
    authEnv: text(128)
      .regex(/^(?:SOURCE_[A-Z0-9_]+)?$/)
      .optional(),
    itemsPath: text(300).optional(),
    mapping: z.record(z.string(), text(200)).optional(),
    text: text(200000).optional(),
    allowedDomains: z
      .array(text(253).regex(/^[a-z0-9.-]+$/))
      .max(30)
      .optional(),
  }),
});
export const supplierSchema = z.object({
  name: text(200).min(1),
  approved: z.boolean(),
  enabled: z.boolean(),
  domains: z.array(text(253).regex(/^[a-z0-9.-]+$/)).max(30),
  orderEndpoint: text(2000),
  authEnv: text(128).regex(/^(?:SUPPLIER_[A-Z0-9_]+)?$/),
  notes: text(5000),
});
const flags = z.object({
  chat: z.boolean(),
  webSearch: z.boolean(),
  showPrice: z.boolean(),
  showStock: z.boolean(),
  showLeadTime: z.boolean(),
  quoteRequests: z.boolean(),
  autoQuote: z.boolean(),
  orders: z.boolean(),
  autoOrder: z.boolean(),
  humanHandoff: z.boolean(),
  // Older saved settings and clients omit this optional feature.
  aiResearch: z.boolean().default(false),
});
export const sourcingEstimatePolicySchema = z
  .object({
    enabled: z.boolean(),
    markupPercent: z.number().min(0).max(1000).multipleOf(0.01).nullable(),
    minimumProfitYen: count.nullable(),
    handlingFeeYen: count.nullable(),
    roundingYen: z.union([z.literal(1), z.literal(10), z.literal(100)]),
    fulfillment: z.enum(['direct', 'via_company']),
    shippingRates: z
      .array(
        z.object({
          destination: z.enum(PREFECTURES),
          shippingNet: count,
        }),
      )
      .max(47)
      .refine(
        (v) => new Set(v.map((r) => r.destination)).size === v.length,
        '都道府県が重複しています',
      ),
    extraBusinessDays: z.number().int().min(0).max(365).nullable(),
    taxRate: z.union([z.literal(0), z.literal(8), z.literal(10)]),
    validityHours: z.number().int().min(1).max(168),
  })
  .superRefine((v, ctx) => {
    if (
      v.enabled &&
      [v.markupPercent, v.minimumProfitYen, v.handlingFeeYen, v.extraBusinessDays].some(
        (n) => n === null,
      )
    )
      ctx.addIssue({
        code: 'custom',
        message:
          '概算を有効にする前に上乗せ率・最低利益・手配料・追加営業日を入力してください（なしの場合は0）',
      });
  });
export const procurementOfferSchema = z
  .object({
    price: count.positive().nullable(),
    taxIncluded: z.boolean().nullable(),
    purchaseTaxRate: z.union([z.literal(0), z.literal(8), z.literal(10)]).nullable(),
    packQuantity: z.number().int().min(1).max(100000).nullable(),
    availableQuantity: z.number().int().min(0).max(1000000000).nullable(),
    procurementShippingNet: count.nullable(),
    customerShippingNet: count.nullable(),
    destination: z.union([z.literal(''), z.enum(PREFECTURES)]),
    deliveryMinDays: z.number().int().min(0).max(365).nullable(),
    deliveryMaxDays: z.number().int().min(0).max(365).nullable(),
    approved: z.boolean(),
  })
  .refine(
    (v) =>
      v.deliveryMinDays === null ||
      v.deliveryMaxDays === null ||
      v.deliveryMinDays <= v.deliveryMaxDays,
    '配送日数の範囲を確認してください',
  );
export const settingsSchema = z.object({
  sourcingEstimate: sourcingEstimatePolicySchema.default({
    ...DEFAULT_SOURCING_ESTIMATE,
    shippingRates: [],
  }),
  flags,
  faq: z
    .object({
      hours: text(300).default(''),
      quoteResponse: text(300).default(''),
      shipping: text(300).default(''),
      pickup: text(300).default(''),
    })
    .default({ hours: '', quoteResponse: '', shipping: '', pickup: '' }),
  searchProvider: z.enum(['none', 'exa', 'tavily', 'openai']),
  decisionProvider: z.enum(['local', 'gemini', 'jev']),
  model: text(100),
  responseProvider: z.enum(['local', 'openai', 'gemini']).default('local'),
  responseModel: text(100).default(''),
  freshnessHours: z.number().min(1).max(8760),
  maxAutoOrderAmount: count,
  companyName: text(200).min(1),
  welcomeMessage: text(2000).min(1),
});
export const inquirySchema = z.object({
  name: text(100).min(1),
  company: text(200),
  email: z.string().email().max(200),
  message: text(5000).min(1),
  consent: z.literal(true),
  conversationId: text(100).optional(),
});
export const quoteRequestSchema = inquirySchema.extend({
  productId: text(100).optional(),
  quantity: z.number().int().min(1).max(100000),
});
export const quoteUpdateSchema = z.object({
  lines: z
    .array(
      z.object({
        productId: text(100).nullable(),
        name: text(300).min(1),
        quantity: z.number().int().min(1).max(100000),
        unitPrice: count,
      }),
    )
    .min(1)
    .max(100),
  shipping: count,
  taxRate: z.union([z.literal(0), z.literal(8), z.literal(10)]),
  expiresAt: z.string().datetime(),
  notes: text(5000),
  status: z.enum(['requested', 'draft', 'issued', 'cancelled']),
});
