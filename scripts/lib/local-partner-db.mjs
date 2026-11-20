import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { resolve } from "node:path";

/** Same local DB identity/persistence as wrangler dev. No remote mode is available. */
export async function openLocalPartnerDB({
  persistPath = ".wrangler/state/v3",
  databaseId = "00000000-0000-0000-0000-000000000002",
} = {}) {
  const options = convertV4MiniflareOptions({
    modules: true,
    script:
      "export default { fetch() { return new Response('local import'); } };",
    compatibilityDate: "2026-11-16",
    d1Databases: { DB: databaseId },
  });
  options.resourcePersistencePath = resolve(persistPath);
  const mf = new Miniflare(options);
  try {
    return { db: await mf.getD1Database("DB"), close: () => mf.dispose() };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}

export async function readCurrentPartnerImport(db) {
  const state = await db
    .prepare(
      "SELECT s.current_version_id,s.revision,s.last_import_status,k.revision AS knowledge_revision FROM partner_master_state s JOIN knowledge k ON k.id=1 WHERE s.id=1",
    )
    .first();
  if (!state) throw new Error("ローカルD1のmigrationを先に適用してください");
  const rows = state.current_version_id
    ? (
        await db
          .prepare(
            "SELECT json FROM partner_master_rows WHERE version_id=? ORDER BY partner_id",
          )
          .bind(state.current_version_id)
          .all()
      ).results.map((row) => JSON.parse(row.json))
    : [];
  return { ...state, partners: rows };
}

export async function applyPartnerImport(db, plan) {
  // D1 batch is transactional: failure cannot publish partial records or change knowledge.
  if (!plan.statements.length) return [];
  return db.batch(plan.statements.map((sql) => db.prepare(sql)));
}

/** Preserve the last version but stop candidate and web decisions after an apply failure. */
export async function failPartnerImport(db, current) {
  const guard = "failed_import_" + Math.random().toString(36).slice(2);
  return db.batch([
    db
      .prepare(
        "INSERT INTO write_guards(id,ok) VALUES(?,EXISTS(SELECT 1 FROM partner_master_state s JOIN knowledge k ON k.id=1 WHERE s.id=1 AND s.revision=? AND k.revision=?))",
      )
      .bind(guard, current.revision, current.knowledge_revision),
    db.prepare(
      "UPDATE partner_master_state SET last_import_status='failed',last_error='取込失敗: 再取込と確認が必要です',revision=revision+1 WHERE id=1",
    ),
    db.prepare("UPDATE knowledge SET revision=revision+1 WHERE id=1"),
    db.prepare("DELETE FROM write_guards WHERE id=?").bind(guard),
  ]);
}
