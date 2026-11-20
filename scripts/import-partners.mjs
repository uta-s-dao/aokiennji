import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readPartnerFile,
  previewPartnerImport,
  buildPartnerImportSQL,
} from "./lib/partner-import.mjs";
import {
  openLocalPartnerDB,
  readCurrentPartnerImport,
  applyPartnerImport,
  failPartnerImport,
} from "./lib/local-partner-db.mjs";

export async function main(args = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (["--apply", "--preview", "--help"].includes(arg))
      options[arg.slice(2)] = true;
    else if (
      ["--file", "--mapping", "--output", "--persist-path"].includes(arg) &&
      args[i + 1] &&
      !args[i + 1].startsWith("--")
    )
      options[arg.slice(2)] = args[++i];
    else throw new Error(`不明または値がないオプション: ${arg}`);
  }
  if (options.help) {
    console.log(
      "node scripts/import-partners.mjs --file FILE.csv|FILE.xlsx --mapping mapping.json [--preview|--apply] [--output /private/path/preview.json] [--persist-path PATH]\nローカルD1専用。デフォルトはプレビュー。DB初期化は npm run db:migrate を先に実行してください。",
    );
    return;
  }
  if (!options.file || !options.mapping || (options.apply && options.preview))
    throw new Error(
      "--file, --mapping と --previewまたは--applyを指定してください",
    );
  const local = await openLocalPartnerDB({
    persistPath: options["persist-path"],
  });
  const current = await readCurrentPartnerImport(local.db).catch(
    async (error) => {
      await local.close();
      throw error;
    },
  );
  try {
    const mapping = JSON.parse(await readFile(options.mapping, "utf8"));
    const table = await readPartnerFile(options.file, mapping);
    const preview = previewPartnerImport(table, mapping, current.partners);
    if (options.output)
      await writeFile(options.output, JSON.stringify(preview, null, 2) + "\n", {
        mode: 0o600,
      });
    console.log(
      JSON.stringify(
        {
          mode: options.apply ? "apply" : "preview",
          source: preview.source,
          resolvedColumns: preview.resolvedColumns,
          columnLabels: preview.columnLabels,
          valid: preview.valid,
          counts: preview.counts,
          changes: Object.fromEntries(
            Object.entries(preview.changes).map(([kind, ids]) => [
              kind,
              { count: ids.length, examples: ids.slice(0, 5) },
            ]),
          ),
          skipped: {
            count: preview.skipped.length,
            examples: preview.skipped.slice(0, 3),
          },
          examples: preview.rawRows
            .slice(0, 3)
            .map(({ row, name, capabilityState }) => ({
              row,
              name,
              capabilityState,
            })),
          conflicts: preview.conflicts,
          ambiguities: preview.ambiguities,
          unconfirmed: preview.unconfirmed,
          contentDigest: preview.contentDigest,
        },
        null,
        2,
      ),
    );
    if (!preview.valid)
      throw new Error(
        "取込内容に競合または曖昧さがあります。現行版は変更していません",
      );
    if (options.apply) {
      if (preview.noop && current.last_import_status === "ready") {
        const latest = await readCurrentPartnerImport(local.db);
        if (
          latest.revision !== current.revision ||
          latest.knowledge_revision !== current.knowledge_revision
        )
          throw new Error(
            "プレビュー後にマスタまたはknowledgeが変更されました。再実行してください",
          );
        console.log(
          JSON.stringify({
            applied: false,
            noop: true,
            versionId: current.current_version_id,
            revision: current.revision,
            knowledgeRevision: current.knowledge_revision,
          }),
        );
        return;
      }
      preview.noop = false;
      const plan = buildPartnerImportSQL(
        preview,
        current.revision,
        current.knowledge_revision,
      );
      await applyPartnerImport(local.db, plan);
      console.log(
        JSON.stringify({
          applied: true,
          versionId: plan.versionId,
          revision: current.revision + 1,
          knowledgeRevision: current.knowledge_revision + 1,
        }),
      );
    }
  } catch (error) {
    if (options.apply)
      await failPartnerImport(local.db, current).catch(() => {
        /* A newer concurrent import must remain authoritative. */
      });
    throw error;
  } finally {
    await local.close();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
