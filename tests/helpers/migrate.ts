import { readdir, readFile } from "node:fs/promises";

export async function migrate(db: { exec(sql: string): Promise<unknown> }) {
  const files = (await readdir("migrations"))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  for (const name of files) {
    const sql = await readFile("migrations/" + name, "utf8");
    await db.exec(sql.replace(/--[^\n]*/g, "").replace(/\n/g, " "));
  }
}
