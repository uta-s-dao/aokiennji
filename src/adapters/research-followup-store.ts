import type { PartnerReport } from "./partner-research";
import { eventPayload, stmt, type Env, type CaseRow, prior } from "./store";
import {
  AppError,
  id,
  type Snapshot,
  type PublicResult,
} from "../domain/model";
import type { ResearchFollowupAnswerRecord } from "../domain/research-followup";

export async function resultDialogue(
  e: Env,
  c: CaseRow,
  result: PublicResult | null,
) {
  if (c.phase !== "completed" || !result || result.stale) return null;
  const row = await stmt(
    e,
    "SELECT json_extract(report_json,'$.followup') AS plan, json_type(report_json,'$.followupAnswer') AS answered FROM partner_reports WHERE job_id=?",
    result.jobId,
  ).first<{ plan: string | null; answered: string | null }>();
  if (!row?.plan) return null;
  const plan: NonNullable<PartnerReport["followup"]> = JSON.parse(row.plan);
  return { jobId: result.jobId, offer: row.answered ? null : plan.offer };
}

export function recordFollowup(
  e: Env,
  c: CaseRow,
  jobId: string,
  record: ResearchFollowupAnswerRecord,
) {
  const guard = id();
  return [
    stmt(
      e,
      `INSERT INTO write_guards VALUES (?, EXISTS(
      SELECT 1 FROM partner_reports p JOIN research_jobs j ON j.id=p.job_id
        JOIN cases c ON j.case_id=c.id JOIN knowledge k ON k.id=1
      WHERE j.id=? AND c.id=? AND c.revision=? AND c.revision=j.input_revision
        AND c.deleted=0 AND c.expires_at>? AND j.status='completed'
        AND k.revision=j.knowledge_revision AND c.phase='completed'
        AND json_extract(p.report_json,'$.followup.offer.id')=?
        AND json_type(p.report_json,'$.followupAnswer') IS NULL))`,
      guard,
      jobId,
      c.id,
      c.revision,
      Date.now(),
      record.offerId,
    ),
    stmt(
      e,
      "UPDATE partner_reports SET report_json=json_set(report_json,'$.followupAnswer',json(?)) WHERE job_id=?",
      JSON.stringify(record),
      jobId,
    ),
    stmt(e, "DELETE FROM write_guards WHERE id=?", guard),
  ];
}

// A refusal or unknown answer closes the offer without invalidating its current result.
export async function closeFollowup(
  e: Env,
  c: CaseRow,
  mutationId: string,
  snapshot: Snapshot,
  record: ResearchFollowupAnswerRecord,
  statements: D1PreparedStatement[],
) {
  const response = { jobId: null, revision: c.revision, phase: "result" };
  try {
    await e.DB.batch([
      ...statements,
      stmt(
        e,
        "UPDATE cases SET snapshot=? WHERE id=?",
        JSON.stringify(snapshot),
        c.id,
      ),
      stmt(
        e,
        "INSERT INTO case_events(id,case_id,mutation_id,revision,response,created_at,event_json) VALUES(?,?,?,?,?,?,?)",
        record.eventId,
        c.id,
        mutationId,
        c.revision,
        JSON.stringify(response),
        Date.now(),
        JSON.stringify({
          ...eventPayload(c, snapshot),
          followupOfferId: record.offerId,
        }),
      ),
    ]);
  } catch (err) {
    const previous = await prior(e, c.id, mutationId);
    if (previous) return previous;
    if (/CHECK|UNIQUE/.test(String(err)))
      throw new AppError("REVISION_CONFLICT", 409);
    throw err;
  }
  return response;
}
