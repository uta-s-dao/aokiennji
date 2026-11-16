const fs = require("node:fs/promises");
const { performance } = require("node:perf_hooks");
const path = require("node:path");
const { parseEnv } = require("node:util");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const Module = require("node:module");
const { build } = require("esbuild");
const {
  reserveBudget,
  LIMIT_MICRO_USD,
  MAX_CALLS,
} = require("./lib/eval-budget.cjs");
const BASELINE_REPORT = "docs/LIVE-EVALUATION-20261116.json";
const REPAIR_REPORT = "docs/LIVE-REPAIR-20261116.json";
const DATASET = "fixtures/evaluation/live-cases-20261116.json";
const LOCK = ".wrangler/live-evaluation.lock";
const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
const phase = getArg("--phase", "pilot");
const REPORT = phase === "repair" ? REPAIR_REPORT : BASELINE_REPORT;
const digest = (text) => createHash("sha256").update(text).digest("hex");
async function save(report) {
  const temp = REPORT + ".tmp";
  await fs.writeFile(temp, JSON.stringify(report, null, 2) + "\n");
  await fs.rename(temp, REPORT);
}
async function loadApp() {
  const built = await build({
    stdin: {
      contents: `export {makeIntakeRequest,OpenAIIntakeExtractor} from './src/adapters/openai-intake.ts'; export {makeSnapshot,makeResearchBrief,chooseNextQuestion} from './src/domain/intake.ts'; export {extractDemo,extractOnce} from './src/adapters/extraction.ts'; export {decideAvailability} from './src/domain/decision.ts'; export {makeMailDraft} from './src/domain/mail.ts';`,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
  });
  const mod = new Module(path.resolve(".wrangler/live-evaluation-app.cjs"));
  mod.paths = module.paths;
  mod._compile(
    built.outputFiles[0].text,
    path.resolve(".wrangler/live-evaluation-app.cjs"),
  );
  return { app: mod.exports, sourceDigest: digest(built.outputFiles[0].text) };
}
function seed(app, sample) {
  const s = sample.prior
    ? app.extractDemo(app.makeSnapshot(sample.id), sample.prior)
    : app.makeSnapshot(sample.id);
  // A prior snapshot is a fixture, not another model result. Keep subject names separate from old conditions.
  for (const item of s.brief.items) {
    const subject = item.label.match(/ガラス|パッキン|架台|リング材/)?.[0];
    if (subject) {
      item.label = subject;
      const f = item.fields.find((f) => f.key === "description");
      if (f?.value) f.value.text = subject;
    }
  }
  return s;
}
function inspectResult(app, sample, result, rawProposal, knowledge) {
  const checks = [];
  const e = sample.expected,
    items = result.brief.items;
  const check = (name, pass, actual) =>
    checks.push({ name, pass: Boolean(pass), actual: actual ?? null });
  const value = (item, key) => item?.fields.find((f) => f.key === key)?.value;
  function compare(item, key, wanted, prefix = "") {
    const actual = value(item, key);
    check(
      prefix + key,
      typeof wanted === "object"
        ? actual?.number === wanted.number && actual?.unit === wanted.unit
        : actual?.text === wanted,
      actual,
    );
  }
  if (e.safeUnresolved) {
    check(
      "ambiguous_target_not_applied",
      result.extractionFailed &&
        result.extractionError === "INVALID_EXTRACTION" &&
        rawProposal?.ambiguities?.length > 0 &&
        !items.some((i) => value(i, "material")?.text === "鉄"),
      result.extractionError,
    );
  } else
    check(
      "extraction_completed",
      !result.extractionFailed,
      result.extractionError,
    );
  if (e.items !== undefined)
    check("item_count", items.length === e.items, items.length);
  if (e.fields)
    for (const [k, v] of Object.entries(e.fields)) compare(items[0], k, v);
  if (e.statuses)
    for (const [k, v] of Object.entries(e.statuses))
      check(
        "status:" + k,
        items[0]?.fields.find((f) => f.key === k)?.status === v,
        items[0]?.fields.find((f) => f.key === k)?.status,
      );
  if (e.requiredFieldContains)
    for (const [k, v] of Object.entries(e.requiredFieldContains))
      check(
        "contains:" + k,
        value(items[0], k)?.text.includes(v),
        value(items[0], k),
      );
  for (const part of e.parts ?? []) {
    const item = items.find((i) => i.label.includes(part.label));
    check("part:" + part.label, !!item, item?.label);
    for (const [k, v] of Object.entries(part.fields ?? {}))
      compare(item, k, v, part.label + ":");
    for (const [k, v] of Object.entries(part.contains ?? {}))
      check(
        part.label + ":contains:" + k,
        value(item, k)?.text.includes(v),
        value(item, k),
      );
  }
  if (e.mustNotInferCustomerMaterial)
    check(
      "paint_is_not_customer_material",
      value(items[0], "material_supply")?.text !== "customer_supplied",
      value(items[0], "material_supply"),
    );
  let resultDto = null,
    question = null,
    mail;
  try {
    question = app.chooseNextQuestion(result, knowledge.rules);
    if (items.length) {
      const brief = app.makeResearchBrief(result, 2, 1);
      resultDto = app.decideAvailability(
        brief,
        knowledge.rules,
        knowledge.sources,
        "eval-" + sample.id,
      );
    }
    mail = app.makeMailDraft(result, resultDto);
  } catch (error) {
    check("downstream_processing", false, error.message);
    mail = app.makeMailDraft(result, null);
  }
  if (e.additionalQuestions === 0)
    check("zero_additional_questions", question === null, question?.fieldKey);
  if (e.mustNotHandle)
    check(
      "no_unapproved_positive",
      !resultDto || resultDto.verdict !== "can_handle",
      resultDto?.verdict,
    );
  if (e.verdict)
    check(
      "business_verdict",
      resultDto?.verdict === e.verdict,
      resultDto?.verdict,
    );
  if (e.scope)
    check(
      "business_scope",
      resultDto?.items[0]?.scopeAssessment.status === e.scope,
      resultDto?.items[0]?.scopeAssessment.status,
    );
  for (const text of e.mailMustNotContain ?? [])
    check(
      "mail_excludes:" + text,
      !mail.body.includes(text),
      mail.body.includes(text),
    );
  if (result.extractionFailed)
    check(
      "failed_input_preserved_in_mail",
      mail.body.includes(sample.input),
      null,
    );
  if (e.pendingInput) {
    check(
      "latest_query_preserved",
      result.unresolvedInputs?.some((e) => e.text === sample.input) &&
        mail.body.includes(sample.input),
      null,
    );
    check("old_verdict_not_in_mail", !mail.body.includes("今回の依頼："), null);
  }
  return {
    checks,
    qualityPass: checks.every((c) => c.pass),
    items,
    unresolvedInputs: result.unresolvedInputs?.map((e) => e.text) ?? [],
    question,
    result: resultDto,
    mailDraft: mail,
  };
}
async function runCase(app, report, settings, knowledge, sample, variant) {
  const id = variant.id + "-" + sample.id;
  const previous = report.calls.find((c) => c.id === id);
  if (previous) {
    console.log(JSON.stringify({ id, state: "already_reserved_or_completed" }));
    return;
  }
  if (
    variant.phase === "repair" &&
    report.calls.filter((c) => c.phase === "repair").length >= 10
  )
    throw new Error("REPAIR_CALL_LIMIT");
  const s = seed(app, sample),
    question = app.chooseNextQuestion(s, knowledge.rules);
  const cfg = {
    key: settings.OPENAI_API_KEY,
    model: settings.INTAKE_MODEL,
    maxOutputTokens: variant.maxOutputTokens,
    maxCallsTotal: MAX_CALLS,
    maxCallsPerCase: 1,
  };
  function modify(payload) {
    return {
      ...payload,
      service_tier: "default",
      ...(variant.effort === "default"
        ? {}
        : { reasoning: { effort: variant.effort } }),
    };
  }
  const payload = modify(
    app.makeIntakeRequest(
      s,
      sample.input,
      question,
      cfg,
      knowledge.rules.map((r) => r.category),
    ),
  );
  const payloadHash = digest(JSON.stringify(payload));
  const countResponse = await fetch(
    "https://api.openai.com/v1/responses/input_tokens",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + cfg.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: payload.model,
        input: payload.input,
        instructions: payload.instructions,
        text: payload.text,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    },
  );
  report.inputCountRequests++;
  if (!countResponse.ok) {
    await countResponse.body?.cancel();
    report.stoppedReason = "TOKEN_PREFLIGHT_HTTP_" + countResponse.status;
    await save(report);
    throw new Error(report.stoppedReason);
  }
  const counted = await countResponse.json();
  const reservation = reserveBudget(report, {
    id,
    inputTokens: counted.input_tokens,
    maxOutputTokens: cfg.maxOutputTokens,
  });
  Object.assign(reservation, {
    caseId: sample.id,
    phase: variant.phase,
    effort: variant.effort,
    timeoutMs: variant.timeoutMs,
    maxOutputTokens: cfg.maxOutputTokens,
    sourceDigest: report.sourceDigest,
  });
  await save(report);
  let responseMeta = null,
    rawProposal = null,
    usage = null,
    providerStatus = null;
  const transport = async (url, init) => {
    if (url !== "https://api.openai.com/v1/responses")
      throw new Error("ENDPOINT_DENIED");
    const body = modify(JSON.parse(init.body));
    if (digest(JSON.stringify(body)) !== payloadHash)
      throw new Error("PAYLOAD_CHANGED_AFTER_PREFLIGHT");
    reservation.state = "request_started";
    reservation.requestStartedAt = new Date().toISOString();
    await save(report);
    const response = await fetch(url, {
      ...init,
      body: JSON.stringify(body),
      redirect: "manual",
    });
    providerStatus = response.status;
    if (response.ok) {
      const raw = await response.clone().json();
      responseMeta = {
        status: raw.status,
        model: raw.model,
        serviceTier: raw.service_tier ?? null,
        usage: raw.usage ?? null,
        incompleteDetails: raw.incomplete_details ?? null,
      };
      const text = raw.output
        ?.flatMap((o) => (o.type === "message" ? (o.content ?? []) : []))
        .find((c) => c.type === "output_text")?.text;
      if (typeof text === "string")
        try {
          rawProposal = JSON.parse(text);
        } catch {
          /* Adapter handles invalid JSON. */
        }
    }
    return response;
  };
  const extractor = new app.OpenAIIntakeExtractor(
    cfg,
    knowledge.rules.map((r) => r.category),
    transport,
    async (u) => {
      usage = u;
    },
  );
  const start = performance.now();
  const result = await app.extractOnce(
    extractor,
    s,
    sample.input,
    question,
    variant.timeoutMs,
  );
  const elapsedMs = Math.round(performance.now() - start);
  // The original E19 expected a confirmed change from a question. Keep that original record intact.
  const gradedSample =
    variant.phase === "repair" && sample.id === "E19"
      ? {
          ...sample,
          expected: {
            ...sample.expected,
            fields: {
              request_scope: "processing",
              material_supply: "customer_supplied",
            },
            verdict: "needs_review",
            pendingInput: true,
          },
        }
      : sample;
  const inspected = inspectResult(
    app,
    gradedSample,
    result,
    rawProposal,
    knowledge,
  );
  Object.assign(reservation, {
    state: result.extractionFailed ? "failed" : "completed",
    completedAt: new Date().toISOString(),
    elapsedMs,
    errorCode: result.extractionError ?? null,
    providerStatus,
    responseMeta,
    rawProposal,
    usage,
    withinDesignDeadline: !result.extractionFailed && elapsedMs <= 3000,
    withinNextQuestionTarget: !result.extractionFailed && elapsedMs <= 2500,
    ...inspected,
  });
  if (usage) {
    reservation.knownUsageUpperMicroUsd = Math.ceil(
      usage.inputTokens * 2.5 + usage.outputTokens * 12,
    );
    if (
      usage.inputTokens > reservation.inputUpperBound ||
      usage.outputTokens > cfg.maxOutputTokens
    )
      report.stoppedReason = "TOKEN_BOUND_EXCEEDED";
  }
  if (
    ["MODEL_AUTH_FAILED", "MODEL_RATE_LIMITED"].includes(result.extractionError)
  )
    report.stoppedReason = result.extractionError;
  await save(report);
  console.log(
    JSON.stringify({
      id,
      ms: elapsedMs,
      error: reservation.errorCode,
      pass: inspected.qualityPass,
      within3s: reservation.withinDesignDeadline,
      reservedUsd:
        report.calls.reduce((s, c) => s + c.reservedMicroUsd, 0) / 1e6,
    }),
  );
  if (report.stoppedReason) throw new Error(report.stoppedReason);
}
async function main() {
  if (!args.includes("--live")) {
    console.error(
      "実通信は行いません。承認済みの評価だけ --live を明示してください。",
    );
    process.exitCode = 2;
    return;
  }
  if (!["pilot", "suite", "repair"].includes(phase))
    throw new Error("INVALID_EVALUATION_PHASE");
  if (phase !== "repair") {
    try {
      await fs.access(REPAIR_REPORT);
      throw new Error("REPAIR_LEDGER_EXISTS_USE_REPAIR_PHASE");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  await fs.mkdir(".wrangler", { recursive: true });
  const lock = await fs.open(LOCK, "wx", 0o600);
  await lock.writeFile(String(process.pid));
  try {
    const settings = parseEnv(await fs.readFile(".dev.vars", "utf8"));
    if (!settings.OPENAI_API_KEY || settings.INTAKE_MODEL !== "gpt-5.6-terra")
      throw new Error("EVALUATION_MODEL_OR_KEY_NOT_CONFIGURED");
    const { app, sourceDigest } = await loadApp();
    const datasetText = await fs.readFile(DATASET, "utf8");
    const dataset = JSON.parse(datasetText);
    const knowledge = JSON.parse(
      await fs.readFile("fixtures/demo/knowledge.json", "utf8"),
    );
    let report;
    try {
      report = JSON.parse(await fs.readFile(REPORT, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const signature = {
      sourceDigest,
      datasetDigest: digest(datasetText),
      knowledgeDigest: digest(JSON.stringify(knowledge)),
    };
    let baseline, baselineHash;
    if (phase === "repair") {
      const baselineText = await fs.readFile(BASELINE_REPORT, "utf8");
      baselineHash = digest(baselineText);
      baseline = JSON.parse(baselineText);
      if (
        baseline.calls.length !== 24 ||
        baseline.calls.reduce((n, c) => n + c.reservedMicroUsd, 0) !== 633565 ||
        baseline.stoppedReason
      )
        throw new Error("BASELINE_BUDGET_CHANGED");
      if (report && report.baseline?.reportDigest !== baselineHash)
        throw new Error("BASELINE_BUDGET_CHANGED");
    }
    if (!report) {
      report = {
        schemaVersion: 1,
        startedAt: new Date().toISOString(),
        model: settings.INTAKE_MODEL,
        limits: { maxCalls: MAX_CALLS, maxMicroUsd: LIMIT_MICRO_USD },
        authorization:
          "User approved 1 USD and at most 40 generation calls in this chat",
        ...signature,
        codeRevision: execFileSync("git", ["rev-parse", "HEAD"])
          .toString()
          .trim(),
        priceBasis: {
          inputUpperPerMillionUSD: 2.5,
          outputPerMillionUSD: 12,
          serviceTier: "default",
          source: "https://developers.openai.com/api/docs/models/gpt-5.6-terra",
        },
        independentEvaluation: false,
        evaluationScope:
          "extraction adapter + domain decisions/mail; browser/API/queue timing is not measured",
        inputCountRequests: baseline?.inputCountRequests ?? 0,
        calls: baseline
          ? baseline.calls.map((c) => ({
              ...c,
              sourceDigest: baseline.sourceDigest,
            }))
          : [],
        ...(baseline
          ? {
              repairMaxCalls: 10,
              baseline: {
                report: BASELINE_REPORT,
                reportDigest: baselineHash,
                sourceDigest: baseline.sourceDigest,
                codeRevision: baseline.codeRevision,
                inheritedCalls: baseline.calls.length,
                inheritedReservedMicroUsd: 633565,
              },
              gradingRevision:
                "repair-1: E19 question kept pending instead of confirming a supply change",
            }
          : {}),
      };
      await save(report);
    }
    for (const [key, value] of Object.entries(signature))
      if (report[key] !== value)
        throw new Error("FROZEN_EVALUATION_INPUT_CHANGED");
    if (report.stoppedReason) throw new Error("EVALUATION_PREVIOUSLY_STOPPED");
    const variants =
      phase === "pilot"
        ? [
            {
              id: "pilot-default",
              phase,
              effort: "default",
              timeoutMs: 3000,
              maxOutputTokens: 1024,
            },
            {
              id: "pilot-none",
              phase,
              effort: "none",
              timeoutMs: 3000,
              maxOutputTokens: 1024,
            },
          ]
        : [
            {
              id:
                phase +
                "-" +
                getArg("--effort", "none") +
                "-" +
                getArg("--deadline-ms", "10000"),
              phase,
              effort: getArg("--effort", "none"),
              timeoutMs: Number(getArg("--deadline-ms", "10000")),
              maxOutputTokens: 2048,
            },
          ];
    for (const v of variants) {
      if (
        !["default", "none", "low"].includes(v.effort) ||
        !Number.isInteger(v.timeoutMs) ||
        v.timeoutMs < 1000 ||
        v.timeoutMs > 15000
      )
        throw new Error("INVALID_EVALUATION_VARIANT");
      const cases =
        phase === "pilot"
          ? dataset.cases.filter((c) => ["E01", "E09"].includes(c.id))
          : phase === "repair"
            ? dataset.cases.filter((c) =>
                [
                  "E01",
                  "E06",
                  "E07",
                  "E08",
                  "E09",
                  "E10",
                  "E13",
                  "E14",
                  "E17",
                  "E19",
                ].includes(c.id),
              )
            : dataset.cases;
      for (const c of cases)
        await runCase(app, report, settings, knowledge, c, v);
    }
    report.updatedAt = new Date().toISOString();
    report.budgetSummary = {
      calls: report.calls.length,
      reservedUsd:
        report.calls.reduce((s, c) => s + c.reservedMicroUsd, 0) / 1e6,
      knownUsageUpperEstimateUsd:
        report.calls.reduce((s, c) => s + (c.knownUsageUpperMicroUsd ?? 0), 0) /
        1e6,
      unknownUsageCalls: report.calls.filter((c) => !c.usage).length,
      invoiceActual: "not_available",
    };
    if (phase === "repair") {
      const rows = report.calls.filter((c) => c.phase === "repair");
      report.repairSummary = {
        calls: rows.length,
        qualityPass: rows.filter((c) => c.qualityPass).length,
        extractionCompleted: rows.filter((c) => c.state === "completed").length,
        completedWithin3000ms: rows.filter((c) => c.withinDesignDeadline)
          .length,
        completedWithin2500ms: rows.filter((c) => c.withinNextQuestionTarget)
          .length,
      };
    }
    await save(report);
    console.log(
      JSON.stringify({ budget: report.budgetSummary, phase, report: REPORT }),
    );
  } finally {
    await lock.close();
    await fs.unlink(LOCK);
  }
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      evaluation: "stopped",
      reason: /^[A-Z_0-9]+$/.test(error.message)
        ? error.message
        : "LOCAL_EVALUATION_ERROR",
    }),
  );
  process.exitCode = 1;
});
