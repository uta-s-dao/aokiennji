const fs = require("node:fs/promises");
const path = require("node:path");
const Module = require("node:module");
const { performance } = require("node:perf_hooks");
const { execFileSync } = require("node:child_process");
const { build } = require("esbuild");
const ROOT = process.cwd();
process.chdir(ROOT);
const stats = (values) => {
  const a = [...values].sort((a, b) => a - b);
  return {
    n: a.length,
    p50Ms: +(
      (a[Math.floor((a.length - 1) / 2)] + a[Math.ceil((a.length - 1) / 2)]) /
      2
    ).toFixed(4),
    p95Ms: +a[Math.ceil(a.length * 0.95) - 1].toFixed(4),
    maxMs: +a.at(-1).toFixed(4),
  };
};
async function main() {
  const data = JSON.parse(
      await fs.readFile("fixtures/evaluation/live-cases-20261116.json", "utf8"),
    ),
    knowledge = JSON.parse(
      await fs.readFile("fixtures/demo/knowledge.json", "utf8"),
    ),
    live = JSON.parse(
      await fs.readFile("docs/LIVE-REPAIR-20261116.json", "utf8"),
    );
  const built = await build({
    stdin: {
      contents: `export {makeIntakeRequest,OpenAIIntakeExtractor,INTAKE_INSTRUCTIONS} from './src/adapters/openai-intake.ts'; export {makeSnapshot,makeResearchBrief,chooseNextQuestion} from './src/domain/intake.ts'; export {extractDemo,extractOnce} from './src/adapters/extraction.ts'; export {decideAvailability} from './src/domain/decision.ts'; export {makeMailDraft} from './src/domain/mail.ts';`,
      resolveDir: ROOT,
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
  });
  const filename = path.resolve(".wrangler/local-latency-analysis.cjs"),
    mod = new Module(filename);
  mod.paths = Module._nodeModulePaths(ROOT);
  mod._compile(built.outputFiles[0].text, filename);
  const app = mod.exports,
    categories = knowledge.rules.map((r) => r.category);
  const config = {
    key: "offline-placeholder",
    model: "gpt-5.6-terra",
    maxOutputTokens: 2048,
    maxCallsTotal: 0,
    maxCallsPerCase: 0,
  };
  function prepare(record) {
    const sample = data.cases.find((c) => c.id === record.caseId),
      s = sample.prior
        ? app.extractDemo(app.makeSnapshot(sample.id), sample.prior)
        : app.makeSnapshot(sample.id);
    for (const item of s.brief.items) {
      const noun = item.label.match(/ガラス|パッキン|架台|リング材/)?.[0];
      if (noun) {
        item.label = noun;
        const f = item.fields.find((f) => f.key === "description");
        if (f?.value) f.value.text = noun;
      }
    }
    const p = JSON.parse(JSON.stringify(record.rawProposal));
    for (const c of p.changes) {
      const index = record.items.findIndex((i) => i.id === c.itemRef);
      if (index >= 0 && s.brief.items[index])
        c.itemRef = s.brief.items[index].id;
    }
    const q = app.chooseNextQuestion(s, knowledge.rules),
      body = JSON.stringify({
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: JSON.stringify(p) }],
          },
        ],
        usage: {
          input_tokens: record.usage.inputTokens,
          output_tokens: record.usage.outputTokens,
        },
      });
    return { s, p, q, body, sample };
  }
  const rows = [],
    aggregate = { build: [], clone: [], extraction: [], downstream: [] };
  for (const record of live.calls.filter((c) => c.phase === "repair")) {
    const measured = { build: [], clone: [], extraction: [], downstream: [] };
    let payloadInfo;
    for (let run = -2; run < 20; run++) {
      const { s, q, body, sample } = prepare(record);
      const start = performance.now();
      const request = app.makeIntakeRequest(
        s,
        sample.input,
        q,
        config,
        categories,
      );
      JSON.stringify(request);
      const buildMs = performance.now() - start;
      const context = JSON.parse(request.input[0].content);
      payloadInfo = {
        requestBytes: Buffer.byteLength(JSON.stringify(request)),
        instructionsChars: request.instructions.length,
        userContextChars: request.input[0].content.length,
        latestUtteranceChars: sample.input.length,
        attributeDictionaryChars: JSON.stringify(context.allowedAttributes)
          .length,
        attributeCount: Object.keys(context.allowedAttributes).length,
        schemaChars: JSON.stringify(request.text.format.schema).length,
        changes: record.rawProposal.changes.length,
        outputJsonChars: JSON.stringify(record.rawProposal).length,
        reasoningSpecified: request.reasoning ?? null,
        streamSpecified: request.stream ?? null,
      };
      let cloneMs;
      const transport = async () => {
        const response = new Response(body);
        const t = performance.now();
        await response.clone().json();
        cloneMs = performance.now() - t;
        return response;
      };
      const extractor = new app.OpenAIIntakeExtractor(
        config,
        categories,
        transport,
        async () => {},
      );
      const t = performance.now();
      const result = await app.extractOnce(extractor, s, sample.input, q);
      const extractionMs = performance.now() - t;
      if (result.extractionFailed)
        throw new Error("REPLAY_FAILED_" + record.caseId);
      const d = performance.now();
      app.chooseNextQuestion(result, knowledge.rules);
      const brief = app.makeResearchBrief(result, 2, 1),
        decision = app.decideAvailability(
          brief,
          knowledge.rules,
          knowledge.sources,
          "local-analysis",
        );
      app.makeMailDraft(result, decision);
      const downstreamMs = performance.now() - d;
      if (run >= 0) {
        for (const [k, v] of Object.entries({
          build: buildMs,
          clone: cloneMs,
          extraction: extractionMs,
          downstream: downstreamMs,
        })) {
          measured[k].push(v);
          aggregate[k].push(v);
        }
      }
    }
    rows.push({
      caseId: record.caseId,
      liveElapsedMs: record.elapsedMs,
      inputTokens: record.usage.inputTokens,
      outputTokens: record.usage.outputTokens,
      payloadInfo,
      local: {
        requestBuild: stats(measured.build),
        responseCloneRead: stats(measured.clone),
        extractionIncludingMockTransportAndClone: stats(measured.extraction),
        questionDecisionMail: stats(measured.downstream),
      },
    });
  }
  const dir = await fs.mkdtemp(path.resolve(".wrangler/latency-analysis-"));
  const journal = [];
  const json = JSON.stringify(live, null, 2) + "\n";
  try {
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      await fs.writeFile(path.join(dir, "journal.tmp"), json);
      await fs.rename(
        path.join(dir, "journal.tmp"),
        path.join(dir, "journal.json"),
      );
      journal.push(performance.now() - t);
    }
  } finally {
    await fs.rm(dir, { recursive: true });
  }
  const example = prepare(
    live.calls.find((c) => c.phase === "repair" && c.caseId === "E01"),
  );
  const delayed = new app.OpenAIIntakeExtractor(
    config,
    categories,
    async () => new Response(example.body),
    async () => new Promise((resolve) => setTimeout(resolve, 50)),
  );
  const test = await app.extractOnce(
    delayed,
    example.s,
    example.sample.input,
    example.q,
    20,
  );
  const result = {
    createdAt: new Date().toISOString(),
    codeRevision: execFileSync("git", ["rev-parse", "HEAD"]).toString().trim(),
    externalRequests: 0,
    modelGenerations: 0,
    method: {
      runtime: process.version,
      location: "WSL local Node, current source",
      fixture: "10 stored repaired responses",
      warmupsPerCase: 2,
      repetitionsPerCase: 20,
      provider: "in-memory Response; no DNS/TLS/remote model/D1/HTTP/browser",
      journaling:
        "20 atomic write/rename runs of recorded report on same filesystem under .wrangler",
      timingCaution:
        "Replay is a local reproduction, not a decomposition of the historical live timings. Clone timing is included in extraction; requestBuild is a separate measurement.",
    },
    summary: {
      requestBuild: stats(aggregate.build),
      responseCloneRead: stats(aggregate.clone),
      extractionIncludingMockTransportAndClone: stats(aggregate.extraction),
      questionDecisionMail: stats(aggregate.downstream),
      journalWrite: stats(journal),
    },
    timeoutScopeDemonstration: {
      immediateMockProvider: true,
      simulatedUsagePersistDelayMs: 50,
      extractionDeadlineMs: 20,
      errorCode: test.extractionError,
      actualD1DelayMeasured: false,
    },
    rows,
  };
  await fs.writeFile(
    "docs/LATENCY-CAUSE-ANALYSIS-20261117.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      summary: result.summary,
      timeoutScopeDemonstration: result.timeoutScopeDemonstration,
      payload: rows[0].payloadInfo,
    }),
  );
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
