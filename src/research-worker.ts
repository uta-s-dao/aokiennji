import {
  type Env,
  type JobRow,
  stmt,
  rules,
  sources,
  audit,
  canPublishPage,
} from "./adapters/store";
import { id, type ResearchBrief } from "./domain/model";
import { loadPartnerMaster } from "./adapters/partner-master";
import { researchPartners } from "./adapters/partner-research";
import { decideAvailability, toPublicResult } from "./domain/decision";
export async function flushOutbox(e: Env) {
  await stmt(
    e,
    "UPDATE research_outbox SET queued_at=NULL,retry_at=? WHERE job_id IN (SELECT id FROM research_jobs WHERE status='running' AND lease_until<=? AND deadline>?)",
    Date.now(),
    Date.now(),
    Date.now(),
  ).run();
  const rows = (
    await stmt(
      e,
      "SELECT job_id FROM research_outbox WHERE queued_at IS NULL AND retry_at<=? LIMIT 20",
      Date.now(),
    ).all<{ job_id: string }>()
  ).results;
  for (const r of rows)
    try {
      await e.RESEARCH_QUEUE.send({ jobId: r.job_id });
      await stmt(
        e,
        "UPDATE research_outbox SET queued_at=?,attempts=attempts+1 WHERE job_id=?",
        Date.now(),
        r.job_id,
      ).run();
    } catch {
      await stmt(
        e,
        "UPDATE research_outbox SET retry_at=?,attempts=attempts+1 WHERE job_id=?",
        Date.now() + 2000,
        r.job_id,
      ).run();
    }
}
export async function runJob(e: Env, jobId: string) {
  let job = await stmt(
    e,
    "SELECT * FROM research_jobs WHERE id=?",
    jobId,
  ).first<JobRow>();
  if (!job || !["queued", "running"].includes(job.status)) return;
  const t = Date.now();
  if (job.deadline <= t) {
    await expireJobs(e);
    return;
  }
  const token = id();
  const claim = await stmt(
    e,
    "UPDATE research_jobs SET status='running',lease_token=?,lease_until=?,stage='登録情報を確認中' WHERE id=? AND status IN ('queued','running') AND (lease_until IS NULL OR lease_until<=?) AND deadline>?",
    token,
    t + 15000,
    jobId,
    t,
    t,
  ).run();
  if (!claim.meta.changes) return;
  job = { ...job, lease_token: token };
  const brief: ResearchBrief = JSON.parse(job.snapshot);
  const [rs, ss, master] = await Promise.all([
    rules(e),
    sources(e),
    e.APP_MODE === "local-demo" ? loadPartnerMaster(e) : null,
  ]);
  const report = master ? await researchPartners(e, job, brief, master) : null;
  // Once an actual partner master is in use, demo rules cannot confer approval.
  const realMaster = master && master.reasonCode !== "not_imported";
  const incomplete =
    brief.attachmentRefs.length > 0 ||
    (report &&
      ((realMaster && report.master.status !== "completed") ||
        ["failed", "incomplete", "disabled", "blocked"].includes(
          report.webStatus,
        )));
  let result = decideAvailability(
    brief,
    realMaster ? rs.filter((r) => !r.isDemo) : rs,
    realMaster ? ss.filter((s) => !s.is_demo) : ss,
    jobId,
    incomplete ? "partial" : "completed",
  );
  if (report) {
    for (const item of result.items) {
      if (item.verdict === "needs_review") {
        const missing = (report.followup?.staffTasks ?? [])
          .filter((task) =>
            task.itemId === item.itemId &&
            (task.customerFieldStatus === "not_asked" ||
              task.customerFieldStatus === "conflict"),
          )
          .map((task) => task.fieldKey);
        item.missingFields = [...new Set([...item.missingFields, ...missing])].slice(0, 40);
      }
      if (
        item.reasonCode === "RESEARCH_INCOMPLETE" &&
        report.webStatus === "disabled"
      ) {
        item.reason =
          "登録資料との照合は完了しました。公開サイトの検索は現在利用できないため、今回の条件で手配できるかは担当者が確認します。";
      }
      const publicPages = report.pages.filter(
        (p) =>
          p.itemId === item.itemId &&
          p.confirmed.length &&
          canPublishPage(e, p.url),
      );
      if (publicPages.length)
        item.webFindings = publicPages
          .slice(0, 4)
          .map(({ url, checkedAt, confirmed, unconfirmed }) => ({
            url,
            checkedAt,
            confirmed,
            unconfirmed,
          }));
    }
  }
  if (brief.attachmentRefs.length) {
    for (const i of result.items) {
      if (
        brief.attachmentRefs.some(
          (a) => a.itemId === i.itemId || a.itemId === null,
        )
      ) {
        i.verdict = "needs_review";
        i.reasonCode = "RESEARCH_INCOMPLETE";
        i.reason =
          "添付の内容解析は未実施のため、今回の仕様は担当者確認が必要です。";
        i.evidence = [];
      }
    }
  }
  result = toPublicResult(result);
  const guard = id(),
    end = Date.now();
  try {
    await e.DB.batch([
      stmt(
        e,
        "INSERT INTO write_guards VALUES (?,EXISTS(SELECT 1 FROM research_jobs j JOIN cases c ON c.id=j.case_id JOIN knowledge k ON k.id=1 WHERE j.id=? AND j.lease_token=? AND j.lease_until>? AND j.deadline>? AND j.status='running' AND c.revision=j.input_revision AND c.deleted=0 AND c.expires_at>? AND k.revision=j.knowledge_revision))",
        guard,
        jobId,
        token,
        end,
        end,
        end,
      ),
      stmt(
        e,
        "INSERT INTO results VALUES(?,?,?)",
        jobId,
        JSON.stringify(result),
        end,
      ),
      ...(report
        ? [
            stmt(
              e,
              "INSERT INTO partner_reports(job_id,report_json) VALUES(?,?)",
              jobId,
              JSON.stringify(report),
            ),
          ]
        : []),
      ...result.items.flatMap((i) =>
        [...i.evidence, ...i.scopeAssessment.evidence].map((ev) =>
          stmt(
            e,
            "INSERT INTO evidence VALUES(?,?,?,?,?,?,?)",
            id(),
            jobId,
            i.itemId,
            rs.find((rule) => rule.id === ev.id)!.sourceId,
            ev.id,
            ev.label,
            end,
          ),
        ),
      ),
      stmt(
        e,
        "UPDATE research_jobs SET status='completed',stage='結果を整理済み',lease_until=NULL WHERE id=?",
        jobId,
      ),
      stmt(e, "UPDATE cases SET phase='completed' WHERE id=?", job.case_id),
      stmt(e, "DELETE FROM write_guards WHERE id=?", guard),
    ]);
  } catch (err) {
    if (String(err).includes("CHECK") || String(err).includes("UNIQUE")) {
      await e.DB.batch([
        stmt(
          e,
          `UPDATE research_jobs SET status='superseded',stage='資料または条件が更新されました'
          WHERE id=? AND lease_token=? AND status='running'
            AND (knowledge_revision<>(SELECT revision FROM knowledge WHERE id=1)
              OR NOT EXISTS(SELECT 1 FROM cases c WHERE c.id=research_jobs.case_id AND c.revision=research_jobs.input_revision AND c.deleted=0 AND c.expires_at>?))`,
          jobId,
          token,
          end,
        ),
        stmt(
          e,
          `UPDATE cases SET phase='collecting'
          WHERE id=? AND revision=? AND phase='researching' AND deleted=0
            AND EXISTS(SELECT 1 FROM research_jobs WHERE id=? AND status='superseded' AND lease_token=?)
            AND NOT EXISTS(SELECT 1 FROM research_jobs WHERE case_id=cases.id AND input_revision=cases.revision AND status IN ('queued','running'))`,
          job.case_id,
          job.input_revision,
          jobId,
          token,
        ),
      ]);
      return;
    }
    await audit(e, job.case_id, "JOB_STORAGE_FAILED");
    throw err;
  }
}
export async function expireJobs(e: Env) {
  const jobs = (
    await stmt(
      e,
      "SELECT * FROM research_jobs WHERE status IN ('queued','running') AND deadline<=?",
      Date.now(),
    ).all<JobRow>()
  ).results;
  for (const j of jobs) {
    const b: ResearchBrief = JSON.parse(j.snapshot);
    const r = decideAvailability(b, [], [], j.id, "failed");
    const g = id();
    try {
      await e.DB.batch([
        stmt(
          e,
          "INSERT INTO write_guards VALUES (?,EXISTS(SELECT 1 FROM research_jobs WHERE id=? AND status IN ('queued','running') AND deadline<=?))",
          g,
          j.id,
          Date.now(),
        ),
        stmt(
          e,
          "INSERT INTO results VALUES(?,?,?) ON CONFLICT(job_id) DO NOTHING",
          j.id,
          JSON.stringify(r),
          Date.now(),
        ),
        stmt(
          e,
          "UPDATE research_jobs SET status='failed',stage='調査期限を超過' WHERE id=?",
          j.id,
        ),
        stmt(
          e,
          "UPDATE cases SET phase='failed' WHERE id=? AND revision=? AND deleted=0",
          j.case_id,
          j.input_revision,
        ),
        stmt(e, "DELETE FROM write_guards WHERE id=?", g),
      ]);
    } catch {
      /* Another consumer already finished. */
    }
  }
}
export async function maintenance(e: Env) {
  await flushOutbox(e);
  await expireJobs(e);
  const expired = (
    await stmt(
      e,
      "SELECT id,object_key FROM attachments WHERE expires_at<=? OR case_id IN (SELECT id FROM cases WHERE deleted=1 OR expires_at<=?)",
      Date.now(),
      Date.now(),
    ).all<{ id: string; object_key: string }>()
  ).results;
  for (const a of expired) {
    await e.FILES.delete(a.object_key);
    await stmt(e, "DELETE FROM attachments WHERE id=?", a.id).run();
  }
  await stmt(
    e,
    "UPDATE cases SET deleted=1,snapshot=NULL WHERE expires_at<=?",
    Date.now(),
  ).run();
  // Remove expired/deleted personal content while retaining only non-content operational metrics.
  await e.DB.batch(
    [
      "evidence",
      "results",
      "research_outbox",
      "research_jobs",
      "case_events",
    ].map((table) =>
      stmt(
        e,
        table === "evidence"
          ? "DELETE FROM evidence WHERE job_id IN (SELECT id FROM research_jobs WHERE case_id IN (SELECT id FROM cases WHERE deleted=1))"
          : table === "results"
            ? "DELETE FROM results WHERE job_id IN (SELECT id FROM research_jobs WHERE case_id IN (SELECT id FROM cases WHERE deleted=1))"
            : table === "research_outbox"
              ? "DELETE FROM research_outbox WHERE job_id IN (SELECT id FROM research_jobs WHERE case_id IN (SELECT id FROM cases WHERE deleted=1))"
              : `DELETE FROM ${table} WHERE case_id IN (SELECT id FROM cases WHERE deleted=1)`,
      ),
    ),
  );
  await stmt(
    e,
    "UPDATE intake_calls SET result_json=NULL WHERE case_id IN (SELECT id FROM cases WHERE deleted=1)",
  ).run();
  await stmt(
    e,
    "DELETE FROM intake_calls WHERE created_at<? AND case_id IN (SELECT id FROM cases WHERE deleted=1)",
    Date.now() - 90 * 86400000,
  ).run();
  await stmt(
    e,
    "DELETE FROM audit_events WHERE created_at<?",
    Date.now() - 90 * 86400000,
  ).run();
  await stmt(
    e,
    "DELETE FROM rate_limits WHERE window<?",
    Math.floor(Date.now() / 60000) - 2,
  ).run();
}
export default {
  async queue(batch: MessageBatch<{ jobId: string }>, env: Env) {
    for (const m of batch.messages)
      try {
        await runJob(env, m.body.jobId);
        m.ack();
      } catch {
        m.retry({ delaySeconds: 1 });
      }
  },
  async scheduled(_c: ScheduledController, e: Env, ctx: ExecutionContext) {
    ctx.waitUntil(maintenance(e));
  },
};
