import { readFile } from "node:fs/promises";
import { localClient } from "./local-api.mjs";
export function parseCSV(text) {
  const rows = [];
  let row = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (c === "," || c === "\n")) {
      row.push(cell.replace(/\r$/, ""));
      cell = "";
      if (c === "\n") {
        rows.push(row);
        row = [];
      }
    } else cell += c;
  }
  if (quoted) throw new Error("CSVの引用符が閉じていません");
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const header = rows.shift();
  if (!header) throw new Error("空のCSV");
  return rows
    .filter((r) => r.some(Boolean))
    .map((r) =>
      Object.fromEntries(
        header.map((k, i) => {
          let v = r[i] ?? "";
          if (
            [
              "predicates",
              "modelAliases",
              "requiredFields",
              "coveredFields",
            ].includes(k)
          )
            v = JSON.parse(v || "[]");
          else if (k === "version") v = Number(v);
          else if (k === "isDemo") v = v === "true";
          else if (
            ["approvedBy", "approvedAt", "validUntil"].includes(k) &&
            v === ""
          )
            v = null;
          return [k, v];
        }),
      ),
    );
}
if (process.argv[1]?.endsWith("import-rules.mjs")) {
  const file = process.argv[2];
  if (!file)
    throw new Error(
      "Usage: npm run rules:import -- file.json|file.csv [--apply]",
    );
  const raw = await readFile(file, "utf8");
  const data = file.endsWith(".csv") ? parseCSV(raw) : JSON.parse(raw);
  const rules = Array.isArray(data) ? data : (data.rules ?? [data]);
  const call = await localClient();
  for (const rule of rules) {
    await call("/admin/rules", { rule, preview: true });
    if (process.argv.includes("--apply")) {
      const state = await call("/admin/state");
      await call("/admin/rules", {
        rule,
        expectedKnowledgeRevision: state.knowledgeRevision,
      });
    }
  }
  console.log(
    `${rules.length}件を${process.argv.includes("--apply") ? "保存" : "検証"}しました。`,
  );
}
