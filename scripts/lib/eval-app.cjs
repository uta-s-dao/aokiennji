const path = require("node:path");
const Module = require("node:module");
const { build } = require("esbuild");
const { createHash } = require("node:crypto");
const digest = (text) => createHash("sha256").update(text).digest("hex");
async function loadApp() {
  const built = await build({
    stdin: {
      contents: `export {makeIntakeRequest,OpenAIIntakeExtractor} from './src/adapters/openai-intake.ts'; export {decodeCompactProposal} from './src/domain/compact-extraction.ts'; export {makeSnapshot,makeResearchBrief,chooseNextQuestion} from './src/domain/intake.ts'; export {extractDemo,extractOnce} from './src/adapters/extraction.ts'; export {decideAvailability} from './src/domain/decision.ts'; export {makeMailDraft} from './src/domain/mail.ts';`,
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

module.exports = { loadApp, seed, inspectResult };
