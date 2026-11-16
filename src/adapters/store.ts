import {
  AppError,
  id,
  type Snapshot,
  type PublicResult,
  type CapabilityRule,
  type Source,
} from "../domain/model";
export type Env = {
  DB: D1Database;
  FILES: R2Bucket;
  RESEARCH_QUEUE: Queue<{ jobId: string }>;
  ASSETS: Fetcher;
  APP_MODE: string;
  LOCAL_ADMIN_TOKEN: string;
  CONTACT_EMAIL: string;
  INTAKE_MODEL: string;
  RESEARCH_MODEL: string;
  EXTERNAL_ENABLED: string;
};
export type CaseRow = {
  id: string;
  owner: string;
  revision: number;
  phase: string;
  snapshot: string | null;
  expires_at: number;
  deleted: number;
};
export type JobRow = {
  id: string;
  case_id: string;
  input_revision: number;
  knowledge_revision: number;
  attempt: number;
  status: string;
  stage: string;
  deadline: number;
  lease_token: string | null;
  lease_until: number | null;
  snapshot: string;
  usage: string;
};
export const stmt = (e: Env, sql: string, ...v: unknown[]) =>
  e.DB.prepare(sql).bind(...v);
export async function knowledge(e: Env) {
  return (await stmt(e, "SELECT revision FROM knowledge WHERE id=1").first<{
    revision: number;
  }>())!.revision;
}
export async function rules(e: Env): Promise<CapabilityRule[]> {
  return (
    await stmt(e, "SELECT json FROM capability_rules").all<{ json: string }>()
  ).results.map((r) => JSON.parse(r.json));
}
export async function sources(e: Env): Promise<Source[]> {
  return (await stmt(e, "SELECT * FROM sources").all<Source>()).results;
}
export async function owned(e: Env, caseId: string, owner: string) {
  const c = await stmt(
    e,
    "SELECT * FROM cases WHERE id=? AND owner=?",
    caseId,
    owner,
  ).first<CaseRow>();
  if (!c) throw new AppError("NOT_OWNER", 404);
  if (c.deleted || c.expires_at <= Date.now())
    throw new AppError("EXPIRED", 410);
  return c;
}
export async function prior(e: Env, caseId: string, mutationId: string) {
  const p = await stmt(
    e,
    "SELECT response FROM case_events WHERE case_id=? AND mutation_id=?",
    caseId,
    mutationId,
  ).first<{ response: string }>();
  return p ? JSON.parse(p.response) : null;
}
export function eventPayload(c: CaseRow, s: Snapshot) {
  const previous: Snapshot | null = c.snapshot ? JSON.parse(c.snapshot) : null;
  return {
    inputEventIds: s.inputs
      .filter((v) => !previous?.inputs.some((e) => e.id === v.id))
      .map((v) => v.id),
    changes: s.brief.items.flatMap((item) =>
      item.fields
        .filter(
          (field) =>
            JSON.stringify(
              previous?.brief.items
                .find((i) => i.id === item.id)
                ?.fields.find((f) => f.key === field.key),
            ) !== JSON.stringify(field),
        )
        .map((field) => ({
          itemId: item.id,
          key: field.key,
          before:
            previous?.brief.items
              .find((i) => i.id === item.id)
              ?.fields.find((f) => f.key === field.key) ?? null,
          after: field,
        })),
    ),
    attachmentRefs: s.brief.attachmentRefs,
    overflow: s.overflow,
  };
}
export async function commit(
  e: Env,
  c: CaseRow,
  mutationId: string,
  s: Snapshot,
  response: unknown,
  job: JobRow | null = null,
) {
  const guard = id(),
    t = Date.now(),
    rev = c.revision + 1;
  s.brief.revision = rev;
  const statements = [
    stmt(
      e,
      "INSERT INTO write_guards VALUES (?,EXISTS(SELECT 1 FROM cases WHERE id=? AND revision=? AND deleted=0 AND expires_at>?))",
      guard,
      c.id,
      c.revision,
      t,
    ),
    stmt(
      e,
      "UPDATE cases SET revision=?,phase=?,snapshot=? WHERE id=?",
      rev,
      job ? "researching" : "collecting",
      JSON.stringify(s),
      c.id,
    ),
    stmt(
      e,
      "UPDATE research_jobs SET status='superseded' WHERE case_id=? AND status IN ('queued','running')",
      c.id,
    ),
    stmt(
      e,
      "INSERT INTO case_events(id,case_id,mutation_id,revision,response,created_at,event_json) VALUES(?,?,?,?,?,?,?)",
      id(),
      c.id,
      mutationId,
      rev,
      JSON.stringify(response),
      t,
      JSON.stringify(eventPayload(c, s)),
    ),
  ];
  if (job) {
    statements.push(
      stmt(
        e,
        "INSERT INTO research_jobs(id,case_id,input_revision,knowledge_revision,attempt,status,stage,deadline,snapshot) VALUES(?,?,?,?,?,?,?,?,?)",
        job.id,
        c.id,
        rev,
        job.knowledge_revision,
        job.attempt,
        "queued",
        "登録情報を確認中",
        job.deadline,
        job.snapshot,
      ),
      stmt(e, "INSERT INTO research_outbox VALUES(?,NULL,?,0)", job.id, t),
    );
  }
  statements.push(stmt(e, "DELETE FROM write_guards WHERE id=?", guard));
  try {
    await e.DB.batch(statements);
  } catch (err) {
    const old = await prior(e, c.id, mutationId);
    if (old) return old;
    if (String(err).includes("CHECK") || String(err).includes("UNIQUE"))
      throw new AppError("REVISION_CONFLICT", 409);
    throw err;
  }
  return response;
}
export async function currentResult(
  e: Env,
  c: CaseRow,
): Promise<PublicResult | null> {
  const row = await stmt(
    e,
    "SELECT r.public_json FROM results r JOIN research_jobs j ON j.id=r.job_id WHERE j.case_id=? ORDER BY r.created_at DESC LIMIT 1",
    c.id,
  ).first<{ public_json: string }>();
  if (!row) return null;
  const r: PublicResult = JSON.parse(row.public_json);
  const rev = await knowledge(e);
  const rs = await rules(e);
  const expired = r.items
    .flatMap((i) => [...i.evidence, ...i.scopeAssessment.evidence])
    .some((ev) => {
      const rule = rs.find((v) => v.id === ev.id);
      return (
        !rule ||
        rule.approvalStatus !== "approved" ||
        !rule.validUntil ||
        Date.parse(rule.validUntil) <= Date.now()
      );
    });
  if (
    r.inputRevision !== c.revision ||
    r.knowledgeRevision !== rev ||
    expired
  ) {
    r.stale = true;
    r.headline = "条件または判断資料が更新されています。再調査してください。";
    r.verdict = r.status === "failed" ? null : "needs_review";
    for (const i of r.items) {
      i.verdict = "needs_review";
      i.reasonCode = "EXPIRED_EVIDENCE";
      i.reason = "現在の条件と有効な根拠で再調査が必要です。";
      i.scopeAssessment = {
        status: "unconfirmed",
        reason: "取扱分野も再確認が必要です。",
        evidence: [],
      };
      i.evidence = [];
    }
  }
  return r;
}
export async function audit(
  e: Env,
  caseId: string | null,
  code: string,
  detail: Record<string, string | number | boolean> = {},
) {
  await stmt(
    e,
    "INSERT INTO audit_events VALUES(?,?,?,?,?)",
    id(),
    caseId,
    code,
    Date.now(),
    JSON.stringify(detail),
  ).run();
}
export async function limit(e: Env, key: string, max = 100) {
  const window = Math.floor(Date.now() / 60000);
  await stmt(
    e,
    "INSERT INTO rate_limits VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window=excluded.window THEN count+1 ELSE 1 END,window=excluded.window",
    key,
    window,
  ).run();
  const n = await stmt(
    e,
    "SELECT count FROM rate_limits WHERE key=?",
    key,
  ).first<{ count: number }>();
  if (n!.count > max) throw new AppError("RATE_LIMITED", 429);
}
