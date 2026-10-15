import type { AiCall, AiUsageContext, AiUsageReport } from '../contracts';
import { db, now, uid } from './db';
import { DIRECT_JEV_ENDPOINT } from './jev-config';

const endpoints = {
  openai: 'https://api.openai.com/v1/responses',
  jev: DIRECT_JEV_ENDPOINT,
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
};
const knownErrors = new Set([
  'unsupported_number',
  'unknown_evidence',
  'business_fact_owned_locally',
  'private_response',
  'unsupported_commitment',
  'unsupported_capability',
  'internal_terms',
  'unstated_condition',
  'empty_supplement',
  'invalid_research',
  'unapproved_sale',
  'hidden_fact',
  'output_limit',
  'too_many_blocks',
  'generation_failed',
  'invalid_classification',
  'invalid_json',
  'invalid_schema',
  'timeout',
  'cancelled',
  'network_error',
  'insufficient_quota',
]);
// After the account reports no credits, OpenAI is not called for a while:
// each failing call took about 6 seconds before the reply fell back.
const QUOTA_PAUSE_MS = 10 * 60 * 1000;
let quotaPausedUntil = 0;
export function openaiQuotaPaused() {
  return Date.now() < quotaPausedUntil;
}
export function pauseOpenaiForQuota(pause = true) {
  quotaPausedUntil = pause ? Date.now() + QUOTA_PAUSE_MS : 0;
}
// "insufficient_quota" in an OpenAI error body or stream event.
export function quotaError(text: string) {
  return /insufficient_quota|credit_balance_exhausted|billing_hard_limit/.test(text);
}
// The newest finished OpenAI call failed for lack of credits: generated
// replies and the staff research are stopped until credits are added.
export function openaiQuotaAlert(): string | undefined {
  const rows = db()
    .prepare("SELECT json FROM ai_calls WHERE provider='openai' ORDER BY created_at DESC LIMIT 10")
    .all() as { json: string }[];
  const latest = rows.map((r) => JSON.parse(r.json) as AiCall).find((c) => c.completedAt);
  return latest?.errorCode === 'insufficient_quota' ? latest.completedAt! : undefined;
}
const integer = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

// Only schema metadata and numeric usage are saved. Never persist request bodies,
// Authorization headers, provider error bodies, or model output here.
export function beginAiCall(input: {
  provider: AiCall['provider'];
  purpose: AiCall['purpose'];
  model: string;
  body: string;
  requestShape: Record<string, unknown>;
  endpoint?: string;
  context?: AiUsageContext;
}) {
  const start = performance.now();
  const record: AiCall = {
    id: uid(),
    createdAt: now(),
    completedAt: null,
    provider: input.provider,
    purpose: input.purpose,
    context: input.context || { scope: 'standalone' },
    model: input.model,
    endpoint: input.endpoint || endpoints[input.provider],
    method: 'POST',
    requestBytes: Buffer.byteLength(input.body),
    requestShape: input.requestShape,
    httpStatus: null,
    requestId: null,
    durationMs: null,
    outcome: 'pending',
    errorCode: null,
    usage: null,
  };
  function persist() {
    db()
      .prepare(
        `INSERT INTO ai_calls(id,created_at,provider,conversation_id,turn_id,scope,json)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json`,
      )
      .run(
        record.id,
        record.createdAt,
        record.provider,
        record.context.conversationId || null,
        record.context.turnId || null,
        record.context.scope,
        JSON.stringify(record),
      );
  }
  db()
    .prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)')
    .run('ai_usage_started_at', record.createdAt);
  persist();
  return {
    response(status: number, headers?: Headers) {
      record.httpStatus = status;
      const requestId = headers?.get('x-request-id');
      if (requestId && /^[A-Za-z0-9_-]{1,200}$/.test(requestId)) record.requestId = requestId;
    },
    usage(raw: unknown) {
      if (!raw || typeof raw !== 'object') return;
      let value = raw as Record<string, any>;
      if (record.provider === 'gemini') {
        const prompt = integer(value.promptTokenCount);
        const total = integer(value.totalTokenCount);
        const candidates = integer(value.candidatesTokenCount);
        const thoughts = integer(value.thoughtsTokenCount);
        value = {
          input_tokens: prompt,
          output_tokens:
            prompt !== null && total !== null && total >= prompt
              ? total - prompt
              : candidates === null
                ? null
                : candidates + (thoughts ?? 0),
          total_tokens: total,
          input_tokens_details: { cached_tokens: value.cachedContentTokenCount },
          output_tokens_details: { reasoning_tokens: thoughts },
        };
      }
      const inputTokens = integer(value.input_tokens),
        outputTokens = integer(value.output_tokens);
      if (inputTokens === null || outputTokens === null) return;
      record.usage = {
        inputTokens,
        outputTokens,
        totalTokens: integer(value.total_tokens) ?? inputTokens + outputTokens,
        cachedInputTokens: integer(value.input_tokens_details?.cached_tokens),
        reasoningTokens: integer(value.output_tokens_details?.reasoning_tokens),
      };
    },
    finish(accepted: boolean, error?: unknown) {
      if (record.completedAt) return;
      record.completedAt = now();
      record.durationMs = Math.round(performance.now() - start);
      const name = error instanceof Error ? error.name : '';
      const message = error instanceof Error ? error.message : '';
      record.outcome = accepted
        ? 'accepted'
        : message === 'insufficient_quota' ||
            (record.httpStatus !== null && (record.httpStatus < 200 || record.httpStatus >= 300))
          ? 'http_error'
          : record.httpStatus !== null
            ? 'rejected'
            : 'network_error';
      record.errorCode = accepted
        ? null
        : message === 'insufficient_quota'
          ? message
          : record.outcome === 'http_error'
            ? `http_${record.httpStatus}`
            : name === 'TimeoutError'
              ? 'timeout'
              : name === 'AbortError'
                ? 'cancelled'
                : name === 'SyntaxError'
                  ? 'invalid_json'
                  : name === 'ZodError'
                    ? 'invalid_schema'
                    : knownErrors.has(message)
                      ? message
                      : 'network_error';
      if (
        record.outcome === 'rejected' &&
        ['timeout', 'cancelled', 'network_error', 'generation_failed'].includes(
          record.errorCode || '',
        )
      )
        record.outcome = 'network_error';
      persist();
    },
  };
}

export function aiUsageReport(
  filters: {
    provider?: AiCall['provider'];
    scope?: AiUsageContext['scope'];
    since?: string;
    until?: string;
    conversationId?: string;
    turnId?: string;
    limit?: number;
  } = {},
): AiUsageReport {
  const where: string[] = [],
    values: string[] = [];
  for (const [column, value] of [
    ['provider', filters.provider],
    ['scope', filters.scope],
    ['conversation_id', filters.conversationId],
    ['turn_id', filters.turnId],
  ])
    if (value) {
      where.push(`${column}=?`);
      values.push(value);
    }
  if (filters.since) {
    where.push('created_at>=?');
    values.push(filters.since);
  }
  if (filters.until) {
    where.push('created_at<=?');
    values.push(filters.until);
  }
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const summaries = (['openai', 'jev', 'gemini'] as const).map((provider) => ({
    provider,
    calls: 0,
    httpSuccess: 0,
    accepted: 0,
    rejected: 0,
    failed: 0,
    pending: 0,
    usageReportedCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cachedUsageReportedCalls: 0,
  }));
  // Summaries cover all matching calls; only the detail list is limited.
  let total = 0;
  for (const row of db()
    .prepare(`SELECT json FROM ai_calls${clause}`)
    .iterate(...values) as Iterable<{ json: string }>) {
    const call = JSON.parse(row.json) as AiCall;
    const s = summaries.find((s) => s.provider === call.provider)!;
    total++;
    s.calls++;
    if (call.httpStatus !== null && call.httpStatus >= 200 && call.httpStatus < 300)
      s.httpSuccess++;
    if (call.outcome === 'accepted') s.accepted++;
    else if (call.outcome === 'pending') s.pending++;
    else if (call.outcome === 'rejected') s.rejected++;
    else s.failed++;
    if (call.usage) {
      s.usageReportedCalls++;
      s.inputTokens += call.usage.inputTokens;
      s.outputTokens += call.usage.outputTokens;
      if (call.usage.cachedInputTokens !== null) {
        s.cachedUsageReportedCalls++;
        s.cachedInputTokens += call.usage.cachedInputTokens;
      }
    }
  }
  const limit = Math.min(Math.max(filters.limit || 200, 1), 500);
  const rows = db()
    .prepare(`SELECT json FROM ai_calls${clause} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...values, limit) as { json: string }[];
  const metadata = db()
    .prepare('SELECT value FROM metadata WHERE key=?')
    .get('ai_usage_started_at') as { value: string } | undefined;
  return {
    recordingStartedAt: metadata?.value || null,
    total,
    summaries: summaries.map((s) => ({
      ...s,
      inputTokens: s.usageReportedCalls ? s.inputTokens : null,
      outputTokens: s.usageReportedCalls ? s.outputTokens : null,
      cachedInputTokens: s.cachedUsageReportedCalls ? s.cachedInputTokens : null,
    })),
    items: rows.map((r) => JSON.parse(r.json)),
  };
}
