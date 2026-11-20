import { id, AppError, type Snapshot, type Question } from "../domain/model";
import {
  DEFAULT_EXTRACTION_TIMEOUT_MS,
  DisabledExtractor,
  demoExtractor,
  extractOnce,
} from "./extraction";
import { completeExplicitFields, recoverExplicitTurn } from "./explicit-intake";
import {
  intakeProvider,
  intakeConfig,
  OpenAIIntakeExtractor,
} from "./openai-intake";
import { type Env, type CaseRow, stmt, rules } from "./store";
const LOCAL_OPENAI_TIMEOUT_MS = 30_000;
const CALL_SETTLEMENT_GRACE_MS = 500;

type CallRow = {
  id: string;
  fingerprint: string;
  state: string;
  result_json: string | null;
  created_at: number;
};
export async function failedIntake(
  s: Snapshot,
  text: string,
  code: string,
): Promise<Snapshot> {
  const result = await extractOnce(
    {
      extract: async () => {
        throw new AppError(code);
      },
    },
    s,
    text,
    null,
  );
  result.extractionError = code;
  return result;
}
export async function configuredIntake(
  e: Env,
  c: CaseRow,
  mutationId: string,
  s: Snapshot,
  text: string,
  q: Question | null,
): Promise<Snapshot> {
  const provider = intakeProvider(e);
  if (provider === "demo") return extractOnce(demoExtractor, s, text, q);
  if (provider === "disabled")
    return extractOnce(new DisabledExtractor(), s, text, q);
  const config = intakeConfig(e);
  const localOpenAI = e.APP_MODE === "local-demo";
  const timeoutMs = localOpenAI
    ? LOCAL_OPENAI_TIMEOUT_MS
    : DEFAULT_EXTRACTION_TIMEOUT_MS;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify({
        revision: c.revision,
        text,
        questionId: q?.id ?? null,
        model: config.model,
        ...(config.format || config.reasoning
          ? {
              format: config.format ?? "full",
              reasoning: config.reasoning ?? null,
            }
          : {}),
      }),
    ),
  );
  const fingerprint = Array.from(new Uint8Array(digest))
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
  async function existing() {
    return stmt(
      e,
      "SELECT id,fingerprint,state,result_json,created_at FROM intake_calls WHERE case_id=? AND mutation_id=?",
      c.id,
      mutationId,
    ).first<CallRow>();
  }
  const previous = await existing();
  if (previous) {
    if (previous.fingerprint !== fingerprint)
      throw new AppError("INVALID_INPUT");
    if (previous.result_json)
      return JSON.parse(previous.result_json) as Snapshot;
    if (Date.now() - previous.created_at < timeoutMs + CALL_SETTLEMENT_GRACE_MS)
      throw new AppError("INTAKE_PENDING", 409);
    // A worker crash may leave an externally billed call without a known result. Do not issue it again.
    const fallback =
      (localOpenAI ? recoverExplicitTurn(s, text, q) : null) ??
      (await failedIntake(s, text, "MODEL_RESULT_UNKNOWN"));
    const updated = await stmt(
      e,
      "UPDATE intake_calls SET state='unknown',error_code='MODEL_RESULT_UNKNOWN',result_json=? WHERE id=? AND state='pending'",
      JSON.stringify(fallback),
      previous.id,
    ).run();
    if (!updated.meta.changes) {
      const final = await existing();
      if (final?.result_json) return JSON.parse(final.result_json) as Snapshot;
    }
    return fallback;
  }
  const callId = id(),
    guard = id();
  try {
    await e.DB.batch([
      stmt(
        e,
        "INSERT INTO write_guards VALUES (?,EXISTS(SELECT 1 FROM cases WHERE id=? AND revision=? AND deleted=0 AND expires_at>?) AND (SELECT blocked_reason IS NULL FROM intake_controls WHERE id=1) AND (? IS NULL OR (SELECT calls FROM intake_totals WHERE id=1)<?) AND (? IS NULL OR (SELECT COUNT(*) FROM intake_calls WHERE case_id=?)<?))",
        guard,
        c.id,
        c.revision,
        Date.now(),
        config.maxCallsTotal,
        config.maxCallsTotal,
        config.maxCallsPerCase,
        c.id,
        config.maxCallsPerCase,
      ),
      stmt(
        e,
        "INSERT INTO intake_calls(id,case_id,mutation_id,expected_revision,fingerprint,provider,model,state,created_at) VALUES(?,?,?,?,?,?,?,'pending',?)",
        callId,
        c.id,
        mutationId,
        c.revision,
        fingerprint,
        provider,
        config.model,
        Date.now(),
      ),
      stmt(e, "UPDATE intake_totals SET calls=calls+1 WHERE id=1"),
      stmt(e, "DELETE FROM write_guards WHERE id=?", guard),
    ]);
  } catch (err) {
    if (await existing()) throw new AppError("INTAKE_PENDING", 409);
    const current = await stmt(
      e,
      "SELECT revision FROM cases WHERE id=? AND deleted=0 AND expires_at>?",
      c.id,
      Date.now(),
    ).first<{ revision: number }>();
    if (!current || current.revision !== c.revision)
      throw new AppError("REVISION_CONFLICT", 409);
    if (!String(err).includes("CHECK")) throw err;
    const control = await stmt(
      e,
      "SELECT blocked_reason FROM intake_controls WHERE id=1",
    ).first<{ blocked_reason: string | null }>();
    return failedIntake(
      s,
      text,
      control?.blocked_reason ?? "MODEL_BUDGET_EXCEEDED",
    );
  }
  const categories = [...new Set((await rules(e)).map((r) => r.category))];
  const extractor = new OpenAIIntakeExtractor(
    config,
    categories,
    fetch,
    async (usage) => {
      if (usage)
        await stmt(
          e,
          "UPDATE intake_calls SET input_tokens=?,output_tokens=? WHERE id=?",
          usage.inputTokens,
          usage.outputTokens,
          callId,
        ).run();
    },
  );
  const attempt = await extractOnce(extractor, s, text, q, timeoutMs);
  const errorCode = attempt.extractionError ?? null;
  const canRecover =
    localOpenAI &&
    attempt.extractionFailed &&
    (errorCode === "MODEL_TIMEOUT" ||
      errorCode === "MODEL_UNAVAILABLE" ||
      errorCode === "INVALID_EXTRACTION");
  const result = canRecover
    ? (recoverExplicitTurn(s, text, q) ?? attempt)
    : localOpenAI && !attempt.extractionFailed
      ? completeExplicitFields(s, attempt, text, q)
      : attempt;
  const saved = await stmt(
    e,
    "UPDATE intake_calls SET state=?,result_json=?,error_code=? WHERE id=? AND state='pending'",
    attempt.extractionFailed ? "failed" : "completed",
    JSON.stringify(result),
    errorCode,
    callId,
  ).run();
  if (!saved.meta.changes) {
    const stored = await existing();
    if (stored?.result_json) return JSON.parse(stored.result_json) as Snapshot;
    throw new AppError("INTAKE_PENDING", 409);
  }
  if (["MODEL_AUTH_FAILED", "MODEL_RATE_LIMITED"].includes(errorCode ?? ""))
    await stmt(
      e,
      "UPDATE intake_controls SET blocked_reason=? WHERE id=1",
      errorCode,
    ).run();
  return result;
}
