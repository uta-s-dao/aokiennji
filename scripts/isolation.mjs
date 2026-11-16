import { readdir, readFile } from "node:fs/promises";
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((e) =>
        e.isDirectory() ? walk(dir + "/" + e.name) : [dir + "/" + e.name],
      ),
    )
  ).flat();
}
const files = [
  ...(await walk("src")),
  ...(await walk("migrations")),
  "wrangler.jsonc",
];
const banned = [
  /aoki-product-discovery/i,
  /conversationId/,
  /\/api\/(?:chat|consultation|inquiry)\b/,
  /https?:\/\/(?!127\.0\.0\.1|localhost)[^\s'"`]+/,
];
const failures = [];
for (const file of files) {
  if (file.startsWith("src/generated/")) continue;
  let content = await readFile(file, "utf8");
  if (file === "src/adapters/openai-intake.ts")
    content = content.replaceAll("https://api.openai.com/v1/responses", "");
  if (file.endsWith(".schema.json"))
    content = content.replaceAll(
      "https://json-schema.org/draft/2020-12/schema",
      "",
    );
  for (const re of banned)
    if (re.test(content)) failures.push(file + ": " + re);
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(
  `isolation: ${files.length} source/config files checked; no legacy dependency; only the dedicated OpenAI endpoint is allowlisted`,
);
