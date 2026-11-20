import type { CapabilityRule, ResearchBrief, Snapshot } from "../domain/model";
import { chooseNextQuestion } from "../domain/intake";
import {
  dimensionKeys,
  maySearchWeb,
  requestKind,
  searchPartnerMaster,
  type PartnerMaster,
  type PartnerSearchResult,
} from "../domain/partner-search";
import {
  planResearchFollowup,
  type ResearchFollowupAnswerRecord,
  type ResearchFollowupPlan,
} from "../domain/research-followup";
import { loadPartnerMaster } from "./partner-master";
import {
  partnerWebConfigured,
  runPartnerWebSearch,
  type PartnerWebResult,
} from "./partner-web";
import { stmt, type Env, type JobRow } from "./store";

export type PartnerPage = {
  itemId: string;
  url: string;
  checkedAt: string;
  confirmed: string[];
  unconfirmed: string[];
};
export type PartnerReport = {
  master: PartnerSearchResult;
  webStatus: PartnerWebResult["status"] | "not_needed";
  webMessage: string;
  pages: PartnerPage[];
  followup?: ResearchFollowupPlan;
  followupAnswer?: ResearchFollowupAnswerRecord;
};

export async function intakeQuestion(
  env: Env,
  s: Snapshot,
  rules: CapabilityRule[],
  force = false,
) {
  const pending = s.brief.items.filter((item) =>
    item.fields.some(
      (f) => f.key === "dimension_unspecified" && f.status === "known",
    ),
  );
  if (force || !s.brief.items.length || env.APP_MODE !== "local-demo")
    return chooseNextQuestion(s, rules, force);
  const master = await loadPartnerMaster(env);
  if (master.status !== "ready") return chooseNextQuestion(s, rules, force);
  const realRules = rules.filter((r) => !r.isDemo);
  if (!pending.length) return chooseNextQuestion(s, realRules, force, [], true);
  const result = searchPartnerMaster(s.brief, master);
  const axes = pending.map((item) => {
    const found = result.items.find((i) => i.itemId === item.id);
    const keys = new Set<string>();
    for (const candidate of [
      ...(found?.match ?? []),
      ...(found?.review ?? []),
    ]) {
      const group = master.partners
        .find((p) => p.id === candidate.partnerId)
        ?.groups.find((g) => g.id === candidate.groupId);
      for (const key of Object.keys(group?.dimensions ?? {})) keys.add(key);
    }
    const allowedRules = rules.filter(
      (r) =>
        !r.isDemo &&
        r.approvalStatus === "approved" &&
        r.category === item.category &&
        r.validUntil &&
        Date.parse(r.validUntil) > Date.now(),
    );
    for (const rule of allowedRules)
      for (const k of [
        ...rule.requiredFields,
        ...rule.predicates.map((p) => p.field),
      ])
        if (dimensionKeys.some((key) => key === k)) keys.add(k);
    // When there is no matching company, the axis also changes a machining web query.
    if (
      !keys.size &&
      !found?.match.length &&
      !found?.review.length &&
      requestKind(item) === "processing"
    ) {
      keys.add("outer_diameter");
      keys.add("overall_length");
    }
    return { itemId: item.id, fieldKeys: [...keys] };
  });
  return chooseNextQuestion(s, realRules, force, axes, true);
}

export async function researchPartners(
  env: Env,
  job: JobRow,
  brief: ResearchBrief,
  master: PartnerMaster,
): Promise<PartnerReport> {
  async function finish(
    report: PartnerReport,
    web?: PartnerWebResult,
  ): Promise<PartnerReport> {
    if (report.master.status !== "completed") {
      if (master.status === "ready") {
        report.followup = planResearchFollowup(brief, report.master, { master });
      }
      return report;
    }
    const history = await stmt(
      env,
      `SELECT json_extract(p.report_json,'$.followupAnswer') AS answer
       FROM partner_reports p JOIN research_jobs j ON j.id=p.job_id
       WHERE j.case_id=? AND json_type(p.report_json,'$.followupAnswer')='object'`,
      job.case_id,
    ).all<{ answer: string }>();
    report.followup = planResearchFollowup(brief, report.master, {
      master,
      web: web ?? { status: report.webStatus, items: [] },
      history: history.results.map(
        (row) => JSON.parse(row.answer) as ResearchFollowupAnswerRecord,
      ),
    });
    return report;
  }
  const complete =
    !brief.attachmentRefs.length &&
    brief.items.every(
      (item) =>
        !!requestKind(item) &&
        !item.notes.some((n) => n.startsWith("未確認の顧客入力：")),
    );
  const lookup = searchPartnerMaster(brief, master, complete);
  const report: PartnerReport = {
    master: lookup,
    webStatus: "not_needed",
    webMessage: "マスタ照合で候補が見つかりました。",
    pages: [],
  };
  if (
    !maySearchWeb(
      lookup,
      brief.items.map((i) => i.id),
    )
  ) {
    if (lookup.status !== "completed")
      report.webMessage = "マスタ照合が完了していないため、Web検索は保留です。";
    return finish(report);
  }
  if (!partnerWebConfigured(env))
    return finish({
      ...report,
      webStatus: "disabled",
      webMessage: "マスタ候補は0件です。Web検索の接続設定が必要です。",
    });
  // Reserve once per job, including after queue redelivery. The lease covers
  // the bounded external work. Old case or knowledge revisions cannot begin it.
  const now = Date.now();
  const reserved = await stmt(
    env,
    `UPDATE research_jobs SET usage=json_set(usage,'$.partnerWebReserved',1),
      stage='公開ページを確認中', lease_until=deadline
      WHERE id=? AND status='running' AND lease_token=? AND lease_until>? AND deadline>?
        AND json_extract(usage,'$.partnerWebReserved') IS NULL
        AND knowledge_revision=(SELECT revision FROM knowledge WHERE id=1)
        AND EXISTS(SELECT 1 FROM cases c WHERE c.id=research_jobs.case_id AND c.revision=research_jobs.input_revision AND c.deleted=0 AND c.expires_at>?)`,
    job.id,
    job.lease_token,
    now,
    now + 1000,
    now,
  ).run();
  if (!reserved.meta.changes)
    return finish({
      ...report,
      webStatus: "incomplete",
      webMessage: "Web検索の状態を確認できませんでした。再調査してください。",
    });
  const web = await runPartnerWebSearch(brief, lookup, env, {
    signal: AbortSignal.timeout(Math.max(1, job.deadline - Date.now() - 500)),
  });
  const pages = web.items.flatMap((item) =>
    item.candidates.map((page) => ({
      itemId: item.itemId,
      url: page.url,
      checkedAt: page.checkedAt,
      confirmed: page.confirmed
        .map((evidence) =>
          `${evidence.condition}（${evidence.excerpt}）`.slice(0, 300),
        )
        .slice(0, 24),
      unconfirmed: [...new Set(page.unconfirmed)]
        .map((s) => s.slice(0, 300))
        .slice(0, 40),
    })),
  );
  const webMessage = {
    completed: pages.length
      ? "公開ページの調査が完了しました。"
      : "検索結果から該当する公開ページを確認できませんでした。",
    incomplete: "一部のページまたは条件を確認できませんでした。",
    failed: "Web検索に失敗しました。担当者が確認してください。",
    blocked: "Web検索の実行条件が揃っていません。",
    disabled: "Web検索の接続設定が必要です。",
  }[web.status];
  const reasons = web.items
    .filter((i) => i.reason)
    .map((i) => {
      const label =
        brief.items.find((item) => item.id === i.itemId)?.label ?? "品目";
      return label + "：" + i.reason;
    });
  return finish(
    {
      ...report,
      webStatus: web.status,
      webMessage: [webMessage, ...reasons].join(" "),
      pages,
    },
    web,
  );
}
