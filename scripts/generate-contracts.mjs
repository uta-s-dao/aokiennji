import { readFile, mkdir, writeFile } from "node:fs/promises";
import Ajv from "ajv/dist/2020.js";
import formats from "ajv-formats";
import standalone from "ajv/dist/standalone/index.js";
import { compile } from "json-schema-to-typescript";
const schema = JSON.parse(
  await readFile("docs/design/contracts.schema.json", "utf8"),
);
const ajv = new Ajv({
  strict: false,
  code: { source: true, esm: true },
  allErrors: true,
});
formats(ajv);
ajv.addSchema(schema);
await mkdir("src/generated", { recursive: true });
const exportsMap = Object.fromEntries(
  Object.keys(schema.$defs)
    .filter((k) => !["Id", "FieldKey", "Value", "Verdict"].includes(k))
    .map((k) => ["validate" + k, schema.$id + "#/$defs/" + k]),
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
