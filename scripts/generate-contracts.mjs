import { readFile, mkdir, writeFile } from "node:fs/promises";
import Ajv from "ajv/dist/2020.js";
import formats from "ajv-formats";
import standalone from "ajv/dist/standalone/index.js";
import { compile } from "json-schema-to-typescript";
const schema = JSON.parse(
  await readFile("docs/design/contracts.schema.json", "utf8"),
);
// Approved chat-first policy: retain the original design copy, extend only the
// count statistic to the existing 100-input abuse limit. Counts no longer end intake.
schema.$defs.ResearchBrief.properties.questionsAsked.maximum = 100;
// Public web references are independent of company approval rules. Older
// results omit this optional field and remain valid.
schema.$defs.PublicWebFinding = {
  type: "object",
  additionalProperties: false,
  required: ["url", "checkedAt", "confirmed", "unconfirmed"],
  properties: {
    url: {type: "string", pattern: "^https://", maxLength: 2000},
    checkedAt: {type: "string", format: "date-time"},
    confirmed: {type: "array", minItems: 1, maxItems: 24, items: {type: "string", minLength: 1, maxLength: 300}},
    unconfirmed: {type: "array", maxItems: 40, items: {type: "string", minLength: 1, maxLength: 300}},
  },
};
schema.$defs.ItemResult.properties.webFindings = {
  type: "array", maxItems: 4, items: {$ref: "#/$defs/PublicWebFinding"},
};
const ajv = new Ajv({
  strict: false,
  code: { source: true, esm: true },
  allErrors: true,
});
formats(ajv);
ajv.addSchema(schema);
const extractionSchema = JSON.parse(
  await readFile("src/domain/extraction.schema.json", "utf8"),
);
ajv.addSchema(extractionSchema);
const compactSchema = JSON.parse(
  await readFile("src/domain/compact-extraction.schema.json", "utf8"),
);
ajv.addSchema(compactSchema);
await mkdir("src/generated", { recursive: true });
const exportsMap = Object.fromEntries(
  Object.keys(schema.$defs)
    .filter((k) => !["Id", "FieldKey", "Value", "Verdict"].includes(k))
    .map((k) => ["validate" + k, schema.$id + "#/$defs/" + k]),
);
exportsMap.validateExtractionProposal = extractionSchema.$id;
exportsMap.validateCompactExtractionProposal = compactSchema.$id;
await writeFile(
  "src/generated/compact-extraction.d.ts",
  await compile(compactSchema, "CompactExtractionProposal", {
    ignoreMinAndMaxItems: true,
  }),
);
await writeFile(
  "src/generated/extraction.d.ts",
  await compile(extractionSchema, "ExtractionProposal", {
    ignoreMinAndMaxItems: true,
  }),
);
let code = standalone(ajv, exportsMap);
code = code.replace(
  /const (\w+) = require\("([^"]+)"\)\.default;/g,
  (_, name, path) =>
    path.endsWith("/ucs2length")
      ? `const ${name} = value => [...value].length;`
      : `import * as runtime_${name} from '${path}.js'; const ${name} = runtime_${name}.default?.default ?? runtime_${name}.default;`,
);
code =
  "import * as runtimeFormats from 'ajv-formats/dist/formats.js';\n" +
  code.replaceAll('require("ajv-formats/dist/formats")', "runtimeFormats");
await writeFile("src/generated/validators.js", code);
await writeFile(
  "src/generated/validators.d.ts",
  Object.keys(exportsMap)
    .map((k) => `export const ${k}: import('ajv').ValidateFunction;`)
    .join("\n"),
);
// Separate roots retain the exact versioned schema. all definitions are exported.
const root = { ...schema, title: "AvailabilityContracts" };
await writeFile(
  "src/generated/contracts.d.ts",
  await compile(root, "AvailabilityContracts", {
    declareExternallyReferenced: true,
    unreachableDefinitions: true,
    ignoreMinAndMaxItems: true,
  }),
);
