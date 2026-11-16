const fs = require("node:fs/promises");
const { performance } = require("node:perf_hooks");
const { parseEnv } = require("node:util");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { reserveBudget, PRICES } = require("./lib/eval-budget.cjs");
const { loadApp, seed, inspectResult } = require("./lib/eval-app.cjs");
const REPORT = "docs/LIVE-FAST-INTAKE-20261117.json",
  PARENT = "docs/LIVE-REPAIR-20261116.json",
  DATA = "fixtures/evaluation/live-cases-20261116.json",
  LOCK = ".wrangler/live-evaluation.lock",
  MODEL = "gpt-6-luna";
const hash = (t) => createHash("sha256").update(t).digest("hex");
const schedule = [
  { caseId: "E01", format: "full" },
  { caseId: "E01", format: "compact" },
  { caseId: "E07", format: "compact" },
  { caseId: "E07", format: "full" },
  { caseId: "E14", format: "full" },
  { caseId: "E14", format: "compact" },
];
async function save(r) {
  await fs.writeFile(REPORT + ".tmp", JSON.stringify(r, null, 2) + "\n");
  await fs.rename(REPORT + ".tmp", REPORT);
}
function budget(r) {
  return {
    calls: r.calls.length,
    reservedUsd: r.calls.reduce((n, c) => n + c.reservedMicroUsd, 0) / 1e6,
    knownUsageUpperEstimateUsd:
      r.calls.reduce((n, c) => n + (c.knownUsageUpperMicroUsd ?? 0), 0) / 1e6,
    unknownUsageCalls: r.calls.filter((c) => !c.usage).length,
    invoiceActual: "not_available",
  };
}
function grade(app, sample, result, proposal, knowledge) {
  const literal = inspectResult(app, sample, result, proposal, knowledge);
  const checks = literal.checks.map((c) => ({ ...c }));
  // Predeclared equivalence: coating label 塗装 + value 不要 + customer quote 塗装不要.
  if (sample.id === "E14") {
    const field = result.brief.items
      .find((i) => i.label.includes("カバー"))
      ?.fields.find((f) => f.key === "coating");
    const equivalent =
      field?.value?.text === "不要" &&
      field.quote.includes("塗装不要") &&
      sample.input.includes(field.quote);
    if (equivalent) {
      const check = checks.find((c) => c.name === "カバー:contains:coating");
      if (check)
        Object.assign(check, {
          pass: true,
          equivalence:
            "塗装 label + 不要 value, explicit source quote retained",
        });
    }
  }
  return {
    ...literal,
    literalQualityPass: literal.qualityPass,
    literalChecks: literal.checks,
    checks,
    qualityPass: checks.every((c) => c.pass),
  };
}
async function main() {
  if (!process.argv.includes("--live")) {
    console.error(
      "実通信は行いません。承認済みの比較だけ --live を明示してください。",
    );
    process.exitCode = 2;
    return;
  }
  await fs.mkdir(".wrangler", { recursive: true });
  const lock = await fs.open(LOCK, "wx", 0o600);
  await lock.writeFile(String(process.pid));
  try {
    const settings = parseEnv(await fs.readFile(".dev.vars", "utf8"));
    if (!settings.OPENAI_API_KEY) throw new Error("KEY_NOT_CONFIGURED");
    const parentText = await fs.readFile(PARENT, "utf8"),
      parent = JSON.parse(parentText);
    if (
      parent.calls.length !== 34 ||
      parent.calls.reduce((n, c) => n + c.reservedMicroUsd, 0) !== 922447 ||
      parent.stoppedReason
    )
      throw new Error("PARENT_BUDGET_CHANGED");
    const { app, sourceDigest } = await loadApp(),
      dataText = await fs.readFile(DATA, "utf8"),
      data = JSON.parse(dataText),
      knowledgeText = await fs.readFile("fixtures/demo/knowledge.json", "utf8"),
      knowledge = JSON.parse(knowledgeText);
    const signature = {
      sourceDigest,
      datasetDigest: hash(dataText),
      knowledgeDigest: hash(knowledgeText),
      parentDigest: hash(parentText),
      harnessDigest: hash(
        await fs.readFile("scripts/live-fast-intake.cjs", "utf8"),
      ),
      helperDigest: hash(await fs.readFile("scripts/lib/eval-app.cjs", "utf8")),
      budgetDigest: hash(
        await fs.readFile("scripts/lib/eval-budget.cjs", "utf8"),
      ),
    };
    let r;
    try {
      r = JSON.parse(await fs.readFile(REPORT, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!r) {
      r = {
        schemaVersion: 1,
        startedAt: new Date().toISOString(),
        codeRevision: execFileSync("git", ["rev-parse", "HEAD"])
          .toString()
          .trim(),
        ...signature,
        parentReport: PARENT,
        parentModel: parent.model,
        inheritedCalls: 34,
        inheritedReservedMicroUsd: 922447,
        authorization:
          "User approved light-model intake with compact deltas and comparison; preserve cumulative 1 USD / 40 generations",
        model: MODEL,
        limits: { maxCalls: 40, maxMicroUsd: 1000000, maxNewCalls: 6 },
        schedule,
        gradingRevision:
          "Existing criteria, plus explicit source-grounded 塗装:不要 equivalence for E14; literal grade also retained",
        configuration: {
          effort: "none",
          maxOutputTokens: 1024,
          timeoutMs: 10000,
          serviceTier: "default",
        },
        priceBasis: {
          model: MODEL,
          publishedSource:
            "https://developers.openai.com/api/docs/models/gpt-6-luna",
          inputUpperPerMillionUsd: PRICES[MODEL].input,
          outputUpperPerMillionUsd: PRICES[MODEL].output,
        },
        independentEvaluation: false,
        scope:
          "extraction adapter -> deterministic questions/decisions/mail; not browser end-to-end",
        timingMethod:
          "native header receipt and full body timestamp; asynchronous diagnostic clone; TTFT not measured",
        inputCountRequests: parent.inputCountRequests,
        calls: parent.calls.map((c) => ({ ...c })),
        seeds: Object.fromEntries(
          ["E01", "E07", "E14"].map((id) => [
            id,
            seed(
              app,
              data.cases.find((c) => c.id === id),
            ),
          ]),
        ),
      };
      await save(r);
    }
    for (const [k, v] of Object.entries(signature))
      if (r[k] !== v) throw new Error("FROZEN_EVALUATION_INPUT_CHANGED");
    if (r.stoppedReason) throw new Error("EVALUATION_PREVIOUSLY_STOPPED");
    for (const plan of schedule) {
      const id = "fast-luna-" + plan.format + "-" + plan.caseId;
      if (r.calls.some((c) => c.id === id)) {
        console.log(
          JSON.stringify({ id, state: "already_reserved_or_completed" }),
        );
        continue;
      }
      if (
        r.calls.length >= 40 ||
        r.calls.filter((c) => c.phase === "fast").length >= 6
      )
        throw new Error("CALL_LIMIT");
      const sample = data.cases.find((c) => c.id === plan.caseId),
        s = JSON.parse(JSON.stringify(r.seeds[plan.caseId])),
        question = app.chooseNextQuestion(s, knowledge.rules);
      const cfg = {
        key: settings.OPENAI_API_KEY,
        model: MODEL,
        format: plan.format,
        reasoning: "none",
        maxOutputTokens: 1024,
        maxCallsTotal: 40,
        maxCallsPerCase: 1,
      };
      const modify = (p) => ({ ...p, service_tier: "default" }),
        payload = modify(
          app.makeIntakeRequest(
            s,
            sample.input,
            question,
            cfg,
            knowledge.rules.map((r) => r.category),
          ),
        ),
        payloadHash = hash(JSON.stringify(payload));
      r.inputCountRequests++;
      await save(r);
      const preflight = await fetch(
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
            reasoning: payload.reasoning,
          }),
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!preflight.ok) {
        await preflight.body?.cancel();
        r.stoppedReason = "TOKEN_PREFLIGHT_HTTP_" + preflight.status;
        await save(r);
        throw new Error(r.stoppedReason);
      }
      const count = await preflight.json(),
        entry = reserveBudget(r, {
          id,
          inputTokens: count.input_tokens,
          maxOutputTokens: cfg.maxOutputTokens,
          model: MODEL,
        });
      Object.assign(entry, {
        phase: "fast",
        caseId: sample.id,
        format: plan.format,
        sourceDigest,
        effort: "none",
        timeoutMs: 10000,
        payloadHash,
        requestBytes: Buffer.byteLength(JSON.stringify(payload)),
      });
      await save(r);
      let responseMeta = null,
        rawWireProposal = null,
        proposal = null,
        usage = null,
        timing = null,
        capture = Promise.resolve(),
        providerStatus = null,
        headerElapsedMs = null;
      const start = performance.now();
      const transport = async (url, init) => {
        if (url !== "https://api.openai.com/v1/responses")
          throw new Error("ENDPOINT_DENIED");
        const body = modify(JSON.parse(init.body));
        if (hash(JSON.stringify(body)) !== payloadHash)
          throw new Error("PAYLOAD_CHANGED_AFTER_PREFLIGHT");
        entry.state = "request_started";
        entry.requestStartedAt = new Date().toISOString();
        await save(r);
        const response = await fetch(url, {
          ...init,
          body: JSON.stringify(body),
          redirect: "manual",
        });
        providerStatus = response.status;
        headerElapsedMs = performance.now() - start;
        if (response.ok)
          capture = response
            .clone()
            .json()
            .then((raw) => {
              responseMeta = {
                status: raw.status,
                model: raw.model,
                serviceTier: raw.service_tier ?? null,
                usage: raw.usage ?? null,
                incompleteDetails: raw.incomplete_details ?? null,
                requestId: response.headers.get("x-request-id"),
              };
              const text = raw.output
                ?.flatMap((o) =>
                  o.type === "message" ? (o.content ?? []) : [],
                )
                .find((c) => c.type === "output_text")?.text;
              if (typeof text === "string") {
                try {
                  rawWireProposal = JSON.parse(text);
                  proposal =
                    cfg.format === "compact"
                      ? app.decodeCompactProposal(s, rawWireProposal)
                      : rawWireProposal;
                } catch {
                  /* adapter reports invalid extraction */
                }
              }
            })
            .catch(() => {});
        return response;
      };
      const extractor = new app.OpenAIIntakeExtractor(
        cfg,
        knowledge.rules.map((r) => r.category),
        transport,
        async (u) => {
          usage = u;
        },
        (t) => {
          timing = t;
        },
      );
      const result = await app.extractOnce(
          extractor,
          s,
          sample.input,
          question,
          10000,
        ),
        elapsedMs = Math.round(performance.now() - start);
      await capture;
      Object.assign(entry, {
        state: result.extractionFailed ? "failed" : "completed",
        completedAt: new Date().toISOString(),
        elapsedMs,
        providerStatus,
        errorCode: result.extractionError ?? null,
        responseMeta,
        rawWireProposal,
        rawProposal: proposal,
        usage,
        timing,
        headerElapsedMs,
        withinDesignDeadline: !result.extractionFailed && elapsedMs <= 3000,
        withinNextQuestionTarget: !result.extractionFailed && elapsedMs <= 2500,
        ...grade(app, sample, result, proposal, knowledge),
      });
      if (usage) {
        entry.knownUsageUpperMicroUsd = Math.ceil(
          usage.inputTokens * PRICES[MODEL].input +
            usage.outputTokens * PRICES[MODEL].output,
        );
        if (
          usage.inputTokens > entry.inputUpperBound ||
          usage.outputTokens > cfg.maxOutputTokens
        )
          r.stoppedReason = "TOKEN_BOUND_EXCEEDED";
      }
      if (
        ["MODEL_AUTH_FAILED", "MODEL_RATE_LIMITED"].includes(
          result.extractionError,
        )
      )
        r.stoppedReason = result.extractionError;
      r.budgetSummary = budget(r);
      await save(r);
      console.log(
        JSON.stringify({
          id,
          ms: elapsedMs,
          pass: entry.qualityPass,
          literalPass: entry.literalQualityPass,
          error: entry.errorCode,
          budget: r.budgetSummary,
        }),
      );
      if (r.stoppedReason) throw new Error(r.stoppedReason);
    }
    const rows = r.calls.filter((c) => c.phase === "fast");
    r.fastSummary = Object.fromEntries(
      ["full", "compact"].map((format) => {
        const selected = rows.filter((c) => c.format === format);
        return [
          format,
          {
            cases: selected.length,
            qualityPass: selected.filter((c) => c.qualityPass).length,
            literalQualityPass: selected.filter((c) => c.literalQualityPass)
              .length,
            completedWithin2500ms: selected.filter(
              (c) => c.withinNextQuestionTarget,
            ).length,
            completedWithin3000ms: selected.filter(
              (c) => c.withinDesignDeadline,
            ).length,
          },
        ];
      }),
    );
    r.budgetSummary = budget(r);
    r.updatedAt = new Date().toISOString();
    await save(r);
    console.log(
      JSON.stringify({ summary: r.fastSummary, budget: r.budgetSummary }),
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
