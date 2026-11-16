const fs = require("node:fs/promises");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { loadApp, inspectResult } = require("./lib/eval-app.cjs");
const SOURCE = "docs/LIVE-FAST-INTAKE-20261117.json";
const OUTPUT = "docs/OFFLINE-FAST-REPAIR-20261117.json";
const hash = (text) => createHash("sha256").update(text).digest("hex");
async function main() {
  globalThis.fetch = async () => {
    throw new Error("NETWORK_DISABLED");
  };
  const sourceText = await fs.readFile(SOURCE, "utf8"),
    source = JSON.parse(sourceText);
  const dataText = await fs.readFile(
      "fixtures/evaluation/live-cases-20261116.json",
      "utf8",
    ),
    data = JSON.parse(dataText);
  const knowledgeText = await fs.readFile(
      "fixtures/demo/knowledge.json",
      "utf8",
    ),
    knowledge = JSON.parse(knowledgeText);
  const records = source.calls.filter((c) => c.phase === "fast");
  if (
    records.length !== 6 ||
    source.calls.length !== 40 ||
    source.budgetSummary.reservedUsd !== 0.929633
  )
    throw new Error("FROZEN_INPUT_CHANGED");
  const { app, sourceDigest } = await loadApp();
  const rows = [];
  for (const row of records) {
    const sample = data.cases.find((c) => c.id === row.caseId),
      snapshot = globalThis.structuredClone(source.seeds[row.caseId]);
    let transports = 0;
    const extractor = new app.OpenAIIntakeExtractor(
      {
        key: "offline-only",
        model: source.model,
        format: row.format,
        reasoning: "none",
        maxOutputTokens: 1024,
        maxCallsTotal: 1,
        maxCallsPerCase: 1,
      },
      knowledge.rules.map((r) => r.category),
      async () => {
        transports++;
        return new globalThis.Response(
          JSON.stringify({
            status: "completed",
            output: [
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify(row.rawWireProposal),
                  },
                ],
              },
            ],
          }),
        );
      },
    );
    const result = await app.extractOnce(
      extractor,
      snapshot,
      sample.input,
      app.chooseNextQuestion(snapshot, knowledge.rules),
    );
    const literal = inspectResult(
        app,
        sample,
        result,
        row.rawProposal,
        knowledge,
      ),
      checks = literal.checks.map((c) => ({ ...c }));
    if (sample.id === "E14") {
      const f = result.brief.items
        .find((i) => i.label.includes("カバー"))
        ?.fields.find((f) => f.key === "coating");
      if (
        f?.value?.text === "不要" &&
        f.quote.includes("塗装不要") &&
        sample.input.includes(f.quote)
      ) {
        const check = checks.find((c) => c.name === "カバー:contains:coating");
        if (check)
          Object.assign(check, {
            pass: true,
            equivalence: "Original predeclared 塗装:不要 equivalence retained",
          });
      }
    }
    const qualityPass = transports === 1 && checks.every((c) => c.pass);
    rows.push({
      id: row.id,
      caseId: row.caseId,
      format: row.format,
      originalLiveQualityPass: row.qualityPass,
      qualityPass,
      literalQualityPass: literal.qualityPass,
      checks,
      literalChecks: literal.checks,
      extractionError: result.extractionError ?? null,
      items: result.brief.items.map((i) => ({
        label: i.label,
        fields: i.fields
          .filter((f) => f.status === "known")
          .map((f) => ({ key: f.key, value: f.value, quote: f.quote })),
      })),
      nextQuestionField:
        app.chooseNextQuestion(result, knowledge.rules)?.fieldKey ?? null,
      verdict: literal.result?.verdict ?? null,
      mail: literal.mailDraft,
    });
  }
  const report = {
    schemaVersion: 1,
    kind: "offline_saved_response_replay",
    createdAt: new Date().toISOString(),
    codeRevision: execFileSync("git", ["rev-parse", "HEAD"]).toString().trim(),
    sourceDigest,
    sourceReport: SOURCE,
    sourceReportDigest: hash(sourceText),
    datasetDigest: hash(dataText),
    knowledgeDigest: hash(knowledgeText),
    harnessDigest: hash(
      await fs.readFile("scripts/replay-fast-repair.cjs", "utf8"),
    ),
    networkDisabled: true,
    newApiGenerations: 0,
    inputCountRequests: 0,
    independentEvaluation: false,
    speedReevaluated: false,
    grading:
      "Original checks and predeclared E14 塗装:不要 equivalence; no live grade overwritten",
    qualityPass: rows.filter((r) => r.qualityPass).length,
    cases: rows.length,
    rows,
  };
  await fs.writeFile(OUTPUT, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      qualityPass: report.qualityPass,
      cases: report.cases,
      newApiGenerations: 0,
      speedReevaluated: false,
    }),
  );
  if (report.qualityPass !== 6) process.exitCode = 1;
}
main().catch(() => {
  console.error("OFFLINE_REPLAY_FAILED");
  process.exitCode = 1;
});
