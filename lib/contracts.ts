export type Availability = 'available' | 'orderable' | 'needs_review' | 'unavailable';
export type SourceKind =
  | 'manual'
  | 'csv'
  | 'xlsx'
  | 'supplier_catalog'
  | 'pdf'
  | 'docx'
  | 'text'
  | 'website'
  | 'csv_url'
  | 'json_api';
export type Trust = 'internal' | 'approved_supplier' | 'discovery';
export type Visibility = 'public' | 'internal';
export type Flags = {
  chat: boolean;
  webSearch: boolean;
  showPrice: boolean;
  showStock: boolean;
  showLeadTime: boolean;
  quoteRequests: boolean;
  autoQuote: boolean;
  orders: boolean;
  autoOrder: boolean;
  humanHandoff: boolean;
  // Staff-only research of prices, lead times and shipping on the web.
  aiResearch: boolean;
};
// Answers to routine questions, written by the company. A blank answer makes
// the chat say that the staff will confirm instead.
export interface CompanyFaq {
  hours: string;
  quoteResponse: string;
  shipping: string;
  pickup: string;
}
// Private commercial rules. Null means the owner has not decided the value.
export interface SourcingEstimatePolicy {
  enabled: boolean;
  markupPercent: number | null;
  minimumProfitYen: number | null;
  handlingFeeYen: number | null;
  roundingYen: 1 | 10 | 100;
  fulfillment: 'direct' | 'via_company';
  shippingRates: { destination: string; shippingNet: number }[];
  extraBusinessDays: number | null;
  taxRate: 0 | 8 | 10;
  validityHours: number;
}
// Private facts for one source; never merge prices and delivery from different sellers.
export interface ProcurementOffer {
  id: string;
  model: string;
  title: string;
  url: string;
  price: number | null;
  taxIncluded: boolean | null;
  purchaseTaxRate: 0 | 8 | 10 | null;
  packQuantity: number | null;
  availableQuantity: number | null;
  procurementShippingNet: number | null;
  customerShippingNet: number | null;
  destination: string;
  deliveryMinDays: number | null;
  deliveryMaxDays: number | null;
  approved: boolean;
  checkedAt: string;
  confirmedAt: string | null;
}
// Public selling terms only: excludes acquisition cost, supplier and margin.
export interface SourcingEstimate {
  model: string;
  quantity: number;
  destination: string;
  unitPrice: number;
  subtotal: number;
  shipping: number;
  tax: number;
  taxRate: number;
  total: number;
  minBusinessDays: number;
  maxBusinessDays: number;
  calculatedAt: string;
  validUntil: string;
}
export interface AppSettings {
  flags: Flags;
  faq: CompanyFaq;
  sourcingEstimate: SourcingEstimatePolicy;
  searchProvider: 'none' | 'exa' | 'tavily' | 'openai';
  decisionProvider: 'local' | 'gemini' | 'jev';
  model: string;
  responseProvider: 'local' | 'openai' | 'gemini';
  responseModel: string;
  freshnessHours: number;
  maxAutoOrderAmount: number;
  companyName: string;
  welcomeMessage: string;
}
export interface PublicConfig {
  flags: Flags;
  demoMode: boolean;
  welcomeMessage: string;
}
export interface ProductInput {
  name: string;
  model: string;
  manufacturer: string;
  category: string;
  description: string;
  specifications: string;
  image: string;
  availability: Availability;
  price: number | null;
  stock: number | null;
  leadTime: string;
  sourceId: string | null;
  supplierId: string | null;
  approved: boolean;
  visibility: Visibility;
  verifiedAt: string | null;
  isDemo: boolean;
}
export interface Product extends ProductInput {
  id: string;
  createdAt: string;
  updatedAt: string;
  evidence?: Evidence[];
}
export interface SourceInput {
  name: string;
  kind: SourceKind;
  url: string;
  enabled: boolean;
  trust: Trust;
  visibility: Visibility;
  syncIntervalHours: number;
  config: {
    authEnv?: string;
    itemsPath?: string;
    mapping?: Record<string, string>;
    text?: string;
    allowedDomains?: string[];
    answerEnabled?: boolean;
  };
}
export interface Source extends SourceInput {
  id: string;
  lastSyncedAt: string | null;
  lastError: string | null;
  recordCount: number;
  createdAt: string;
}
export interface SourceRun {
  id: string;
  sourceId: string;
  status: 'success' | 'failed';
  count: number;
  message: string;
  createdAt: string;
}
export interface SupplierInput {
  name: string;
  approved: boolean;
  enabled: boolean;
  domains: string[];
  orderEndpoint: string;
  authEnv: string;
  notes: string;
}
export interface Supplier extends SupplierInput {
  id: string;
  createdAt: string;
}
// Private records. Only approved field labels may be returned to customers.
export interface SupplierKnowledgeRow {
  supplierName: string;
  website: string;
  products: string;
  fields: string[];
  sheet: string;
  row: number;
}
export interface SupplierKnowledge extends SupplierKnowledgeRow {
  id: string;
  sourceId: string;
  approved: boolean;
  importedAt: string;
}
export interface KnowledgeTopic {
  fields: string[];
  mode: 'fields' | 'privacy' | 'scope';
}
export interface Evidence {
  id?: string;
  title: string;
  url?: string;
  excerpt: string;
  retrievedAt: string;
  sourceId?: string;
  visibility: Visibility;
  trust: Trust;
}
export interface QueryIntent {
  intent: 'product' | 'price' | 'stock' | 'lead_time' | 'quote' | 'order' | 'custom' | 'general';
  terms: string[];
  model?: string;
  confidence: number;
  provider: string;
  warning?: string;
  referencesPrevious?: boolean;
  topicField?: string;
  evidenceIndex?: number;
}
export interface ProductSourcing {
  model: string;
  status: 'candidate' | 'identified' | 'not_found' | 'failed';
  checkedAt: string;
}
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  // A streamed reply retained for staff before it has completed.
  incomplete?: boolean;
  // Public outcome only. Supplier URLs and acquisition prices stay in research notes.
  sourcing?: ProductSourcing;
  estimate?: SourcingEstimate;
  // Private fingerprint used to invalidate an old estimate after staff edits.
  estimateRevision?: string;
  knowledge?: KnowledgeTopic;
  createdAt: string;
  products?: Product[];
  evidence?: Evidence[];
  suggestions?: string[];
  intent?: QueryIntent['intent'];
  factualIntents?: ('price' | 'stock' | 'lead_time' | 'quote' | 'order')[];
  presentation?: 'products' | 'reply' | 'selection';
  requestedQuantity?: number;
  requestedDestination?: string;
  // Parts of a fact question answered from registered values, kept so the
  // reply can be rebuilt with the same wording.
  factDetail?: { unit?: string; taxIncluded?: boolean; shipping?: boolean; deadline?: boolean };
  responseProvider?: 'local' | 'openai' | 'gemini';
  groundingHash?: string;
  // Route reason from the chat policy (CHAT_ROUTE_LABELS key).
  route?: string;
  // Content depends on this conversation (generated text or a local summary),
  // so it cannot be rebuilt from registered facts alone.
  composed?: boolean;
  // A next step offered under the reply: an inquiry or a quote request with
  // the conversation attached and the draft placed in the form.
  handoff?: 'inquiry' | 'quote';
  handoffProductId?: string;
  handoffDraft?: string;
}
export type ResearchAspect = 'price' | 'lead_time' | 'stock' | 'shipping' | 'availability';
export const RESEARCH_ASPECT_LABELS: Record<ResearchAspect, string> = {
  availability: '商品・調達候補',
  price: '価格',
  lead_time: '出荷・納期',
  stock: '在庫',
  shipping: '配送日数・送料',
};
// What the research found on one web page. Shown to staff only.
export interface ResearchFinding {
  aspect: ResearchAspect;
  // As written on the page, e.g. "¥18,700(税込)" or "2～3日出荷".
  value: string;
  note: string;
  title: string;
  url: string;
  source: 'maker' | 'retailer' | 'carrier' | 'supplier' | 'other';
  // matched: the value is on the page fetched by this server. partial: only
  // some of it, or a short word that alone proves little. mismatch: the page
  // was read but does not say this (likely misread). unreachable: the site
  // refused automated access, so a person has to check it.
  check: 'matched' | 'partial' | 'mismatch' | 'unreachable';
  // Probability from the decision model that the page is about the item.
  relevance: number | null;
  // Whether the page shows the model or size the customer asked for; false
  // means the value may belong to another variant.
  itemOnPage?: boolean;
  supplierName?: string;
}
export interface ResearchNote {
  id: string;
  conversationId: string;
  turnId: string;
  createdAt: string;
  completedAt: string | null;
  status: 'running' | 'done' | 'failed';
  subject: string;
  sourcing?: ProductSourcing;
  offers?: ProcurementOffer[];
  aspects: ResearchAspect[];
  destination?: string;
  // As the customer wrote it ("10個、6個"); older notes hold a number.
  quantity?: string | number;
  findings: ResearchFinding[];
  summary: string;
  // Who judged that research was needed.
  decidedBy: 'jev' | 'local';
  error?: string;
}
export interface Conversation {
  id: string;
  title: string;
  status: 'open' | 'handed_off' | 'closed';
  createdAt: string;
  updatedAt: string;
}
export interface ChatResponse {
  conversationId: string;
  message: ChatMessage;
}
export interface InquiryInput {
  name: string;
  company: string;
  email: string;
  message: string;
  conversationId?: string;
  consent: boolean;
}
export interface Inquiry extends InquiryInput {
  id: string;
  status: 'new' | 'in_progress' | 'resolved';
  notes: string;
  createdAt: string;
}
export interface QuoteRequestInput {
  name: string;
  company: string;
  email: string;
  message: string;
  consent: boolean;
  productId?: string;
  quantity: number;
  conversationId?: string;
}
export interface QuoteLine {
  productId: string | null;
  name: string;
  quantity: number;
  unitPrice: number;
}
export interface Quote {
  id: string;
  token: string;
  // The chat the request came from, for the staff only.
  conversationId?: string;
  name: string;
  company: string;
  email: string;
  message: string;
  lines: QuoteLine[];
  shipping: number;
  taxRate: number;
  subtotal: number;
  tax: number;
  total: number;
  status: 'requested' | 'draft' | 'issued' | 'accepted' | 'cancelled';
  expiresAt: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
  isDemo: boolean;
}
export interface Order {
  id: string;
  quoteId: string;
  supplierId: string | null;
  status:
    | 'pending_approval'
    | 'approved'
    | 'dispatched'
    | 'simulated'
    | 'failed'
    | 'needs_reconciliation';
  total: number;
  isDemo: boolean;
  externalId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface AuditEvent {
  id: string;
  action: string;
  entityId: string;
  summary: string;
  createdAt: string;
}
export interface AiUsageContext {
  scope: 'chat' | 'connection_check' | 'standalone';
  conversationId?: string;
  turnId?: string;
}
export interface AiCall {
  id: string;
  createdAt: string;
  completedAt: string | null;
  provider: 'openai' | 'jev' | 'gemini';
  purpose: 'classification' | 'response' | 'research' | 'research_decision';
  context: AiUsageContext;
  model: string;
  endpoint: string;
  method: 'POST';
  requestBytes: number;
  requestShape: Record<string, unknown>;
  httpStatus: number | null;
  requestId: string | null;
  durationMs: number | null;
  outcome: 'pending' | 'accepted' | 'rejected' | 'http_error' | 'network_error';
  errorCode: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cachedInputTokens: number | null;
    reasoningTokens: number | null;
  } | null;
}
export interface AiUsageReport {
  recordingStartedAt: string | null;
  total: number;
  summaries: {
    provider: AiCall['provider'];
    calls: number;
    httpSuccess: number;
    accepted: number;
    rejected: number;
    failed: number;
    pending: number;
    usageReportedCalls: number;
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens: number | null;
    cachedUsageReportedCalls: number;
  }[];
  items: AiCall[];
}
// Staff-only execution metadata, stored with the reply and stripped from public history.
export interface AnswerProcessing {
  classificationProvider: string;
  responseProvider: NonNullable<ChatMessage['responseProvider']>;
  responseMode: 'local' | 'ai' | 'mixed';
  responseReason: string;
  responseModel: string | null;
  durationMs: number;
  webSearch: boolean;
}
export interface StoredChatMessage extends ChatMessage {
  replyToId?: string;
  processing?: AnswerProcessing;
}
export interface AiAnswer {
  id: string;
  conversationId: string;
  content: string;
  createdAt: string;
  incomplete: boolean;
  responseProvider: ChatMessage['responseProvider'] | null;
  route: string | null;
  processing: AnswerProcessing | null;
  linkage: 'recorded' | 'legacy' | 'unknown';
  calls: AiCall[];
}
export interface AiAnswerReport {
  total: number;
  items: AiAnswer[];
}
export interface Overview {
  products: number;
  sources: number;
  conversations: number;
  inquiries: number;
  quotes: number;
  orders: number;
  pendingInquiries: number;
  pendingOrders: number;
  recentEvents: AuditEvent[];
  demoMode: boolean;
  // When the newest OpenAI call failed for lack of credits.
  openaiQuotaExhaustedAt?: string;
}
export interface ImportRowError {
  row: number;
  message: string;
}
export interface ParsedSource {
  supplierRows?: SupplierKnowledgeRow[];
  headers: string[];
  rows: Record<string, string>[];
  documents: { title: string; content: string; url?: string }[];
  warnings: string[];
}
export interface ImportPreview extends ParsedSource {
  previewId: string;
  sourceId: string;
  fileName: string;
  suggestedMapping: Record<string, string>;
  totalRows: number;
}
export interface ImportResult {
  imported: number;
  updated: number;
  documents: number;
  errors: ImportRowError[];
  warnings: string[];
}
export interface ProviderStatus {
  id: string;
  name: string;
  configured: boolean;
  envKey: string;
  purpose: string;
  check?: ProviderCheck;
}
export interface ProviderCheck {
  ok: boolean;
  checkedAt: string;
  model: string;
  message: string;
  durationMs: number;
}
export interface DispatchResult {
  externalId: string;
  status: 'dispatched' | 'needs_reconciliation';
  message?: string;
}
export interface ApiResult<T> {
  data?: T;
  error?: { code: string; message: string };
}

export const DEFAULT_SOURCING_ESTIMATE: SourcingEstimatePolicy = {
  enabled: false,
  markupPercent: null,
  minimumProfitYen: null,
  handlingFeeYen: null,
  roundingYen: 1,
  fulfillment: 'direct',
  shippingRates: [],
  extraBusinessDays: null,
  taxRate: 10,
  validityHours: 24,
};
export const DEFAULT_SETTINGS: AppSettings = {
  sourcingEstimate: DEFAULT_SOURCING_ESTIMATE,
  flags: {
    chat: true,
    webSearch: false,
    showPrice: true,
    showStock: true,
    showLeadTime: true,
    quoteRequests: true,
    autoQuote: false,
    orders: false,
    autoOrder: false,
    humanHandoff: true,
    aiResearch: false,
  },
  faq: { hours: '', quoteResponse: '', shipping: '', pickup: '' },
  searchProvider: 'none',
  decisionProvider: 'local',
  model: '',
  responseProvider: 'local',
  responseModel: '',
  freshnessHours: 168,
  maxAutoOrderAmount: 100000,
  companyName: 'アオキエンジ株式会社',
  welcomeMessage:
    'お探しの製品や、ものづくりのお困りごとをお聞かせください。商品名・型番・用途からご案内します。',
};
export const AVAILABILITY_LABELS: Record<Availability, string> = {
  available: '取扱あり',
  orderable: '取り寄せ対応',
  needs_review: '要確認',
  unavailable: '取扱対象外',
};
export const SOURCE_LABELS: Record<SourceKind, string> = {
  manual: '手動登録',
  csv: 'CSV',
  xlsx: 'Excel',
  supplier_catalog: '仕入・外注先一覧（Excel）',
  pdf: 'PDF',
  docx: 'Word',
  text: 'テキスト',
  website: 'Webサイト',
  csv_url: '公開CSV・スプレッドシート',
  json_api: 'REST API',
};
