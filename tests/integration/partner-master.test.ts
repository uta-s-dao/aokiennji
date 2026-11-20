import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { loadPartnerMaster } from "../../src/adapters/partner-master";
import {
  applyPartnerImport,
  failPartnerImport,
  readCurrentPartnerImport,
  openLocalPartnerDB,
} from "../../scripts/lib/local-partner-db.mjs";
import {
  buildPartnerImportSQL,
  parseCSVRows,
  previewPartnerImport,
  readPartnerFile,
  type PartnerMapping,
  type PartnerTable,
} from "../../scripts/lib/partner-import.mjs";

let mf: Miniflare, db: D1Database, directory: string;
const mapping: PartnerMapping = {
  sheet: "仕入",
  headerRow: 1,
  columns: { name: "A", item: "B", website: "C" },
};
const table = (text: string): PartnerTable => ({
  fileName: "synthetic.csv",
  sourceId: "synthetic",
  sheet: "仕入",
  rows: parseCSVRows(text),
});
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "partner-master-test-"));
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default {fetch(){return new Response('test')}}",
      compatibilityDate: "2026-11-16",
      d1Databases: { DB: "test-partner" },
    }),
  );
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  const sql = await Promise.all(
    ["0001.sql", "0005_partner_master.sql"].map((name) =>
      readFile("migrations/" + name, "utf8"),
    ),
  );
  await db.exec(
    sql
      .join("\n")
      .replace(/--[^\n]*/g, "")
      .replace(/\n/g, " "),
  );
});
afterAll(async () => {
  await mf.dispose();
  await rm(directory, { recursive: true, force: true });
});

describe("private partner master import", () => {
  it("imports explicitly mapped hole axes and counts separately from order quantity", () => {
    const source = table(
      "会社,加工,穴径上限,開口径上限,穴数上限,依頼数上限\n穴加工会社,穴あけ,8,30,4,100\n",
    );
    const configured: PartnerMapping = {
      columns: { name: "会社" },
      capabilities: [
        {
          column: "加工",
          field: "process",
          group: "machine",
          kind: "processing",
        },
        {
          column: "穴径上限",
          field: "dimension",
          axis: "hole_diameter",
          numeric: true,
          unit: "mm",
          bound: "max",
          group: "machine",
          kind: "processing",
        },
        {
          column: "開口径上限",
          field: "dimension",
          axis: "opening_diameter",
          numeric: true,
          unit: "mm",
          bound: "max",
          group: "machine",
          kind: "processing",
        },
        {
          column: "穴数上限",
          field: "hole_count",
          numeric: true,
          unit: "か所",
          bound: "max",
          group: "machine",
          kind: "processing",
        },
        {
          column: "依頼数上限",
          field: "quantity",
          numeric: true,
          unit: "個",
          bound: "max",
          group: "machine",
          kind: "processing",
        },
      ],
    };
    const preview = previewPartnerImport(source, configured);
    expect(preview.valid).toBe(true);
    expect(preview.partners[0].groups[0]).toMatchObject({
      dimensions: {
        hole_diameter: { max: 8, unit: "mm" },
        opening_diameter: { max: 30, unit: "mm" },
      },
      holeCount: { max: 4, unit: "か所" },
      quantity: { max: 100, unit: "個" },
    });
    expect(preview.columnLabels["capability.1"]).toContain("穴径");
    expect(preview.columnLabels["capability.2"]).toContain("開口径");
    expect(preview.columnLabels["capability.3"]).toContain("穴数");
    const invalid = structuredClone(configured);
    invalid.capabilities![3].unit = "mm";
    expect(() => previewPartnerImport(source, invalid)).toThrow("数値穴数");
    invalid.capabilities![3] = {
      ...configured.capabilities![3],
      axis: "hole_diameter",
    };
    expect(() => previewPartnerImport(source, invalid)).toThrow("dimension列");
    const fractional = structuredClone(source);
    fractional.rows[1].cells.E = "4.5";
    const unknown = previewPartnerImport(fractional, configured);
    expect(unknown.partners[0].groups[0].holeCount).toBeUndefined();
    expect(unknown.unconfirmed).toEqual([
      expect.objectContaining({ field: "hole_count", text: "4.5" }),
    ]);
  });
  it("reads CSV/XLSX to common rows, excludes ruby, and maintains IDs across formats", async () => {
    const file = join(directory, "synthetic.xlsx");
    execFileSync("python3", [
      "-c",
      `import zipfile,sys
with zipfile.ZipFile(sys.argv[1],'w') as z:
 z.writestr('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="仕入" sheetId="1" r:id="rId1"/></sheets></workbook>')
 z.writestr('xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
 z.writestr('xl/sharedStrings.xml','<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>テスト精機</t><rPh sb="0" eb="2"><t>てすと</t></rPh></si></sst>')
 z.writestr('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>仕入先</t></is></c></row><row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2" t="inlineStr"><is><r><t>リング</t></r><rPh><t>るび</t></rPh></is></c><c r="C2" t="inlineStr"><is><t>https://supplier.invalid</t></is></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>一覧商事</t></is></c></row></sheetData></worksheet>')`,
      file,
    ]);
    const xlsx = previewPartnerImport(
      await readPartnerFile(file, mapping),
      mapping,
    );
    const csv = previewPartnerImport(
      await readPartnerFile(
        "tests/fixtures/partner-master/suppliers.csv",
        mapping,
      ),
      mapping,
      xlsx.partners,
    );
    expect(csv.counts).toEqual({ partners: 2, documented: 1, listOnly: 1 });
    expect(xlsx.partners[0].name).toBe("テスト精機");
    expect(xlsx.contentDigest).toBe(csv.contentDigest);
    expect(csv.changes).toEqual({
      added: [],
      removed: [],
      changed: [],
      unchanged: xlsx.partners.map((p) => p.id),
    });
    expect(csv.partners[0].sourceRefs).toHaveLength(2);
    expect(csv.partners[0].groups[0].sourceRefs).toHaveLength(2);
    expect(csv.partners[0].sourceRefs[1]).toMatchObject({
      fileName: "suppliers.csv",
      sheet: "仕入",
      row: 2,
      rawValues: { A: "テスト精機", B: "リング" },
      columns: { name: "A", item: "B" },
      columnLabels: { item: expect.stringContaining("取扱品") },
    });
    expect(csv.partners[1].groups).toEqual([]);
  });
  it("retains equivalent CSV/XLSX evidence inside one logical source, then removes superseded groups", async () => {
    const m = { ...mapping, sourceKey: "stable-source" };
    const a = {
      ...table("名,品,HP\n会社A,リング,\n"),
      fileName: "original.xlsx",
      sourceId: "xlsx",
    };
    const b = {
      ...table("名,品,HP\n会社A,リング,\n"),
      fileName: "export.csv",
      sourceId: "csv",
    };
    const first = previewPartnerImport(a, m);
    const equivalent = previewPartnerImport(b, m, first.partners);
    expect(equivalent.partners[0].groups).toHaveLength(1);
    expect(equivalent.partners[0].groups[0].sourceRefs).toHaveLength(2);
    expect(previewPartnerImport(b, m, equivalent.partners).noop).toBe(true);
    const changed = previewPartnerImport(
      { ...b, rows: parseCSVRows("名,品,HP\n会社A,板,\n") },
      m,
      equivalent.partners,
    );
    expect(
      changed.partners[0].groups.flatMap((group) => group.products ?? []),
    ).toEqual(["板"]);
    expect(changed.partners[0].groups[0].sourceRefs).toHaveLength(1);
  });
  it("shares the production mapping and verifies its named headers", async () => {
    const productionMapping = JSON.parse(
      await readFile("config/partner-mappings/purchasing-ledger.json", "utf8"),
    );
    const source: PartnerTable = {
      fileName: "synthetic.xlsx",
      sourceId: "test",
      sheet: "仕入",
      rows: [
        { row: 1, cells: { A: "仕入先", AA: "取扱い品", AC: "HP" } },
        {
          row: 2,
          cells: {
            A: "架空会社",
            AA: "リング",
            AC: "https://supplier.invalid",
            B: "秘密の金額",
          },
        },
      ],
    };
    const preview = previewPartnerImport(source, productionMapping);
    expect(preview.resolvedColumns).toEqual({
      name: "A",
      item: "AA",
      website: "AC",
    });
    expect(preview.partners[0].sourceRefs[0]).toMatchObject({
      sourceKey: "purchasing-ledger",
      rawValues: {
        A: "架空会社",
        AA: "リング",
        AC: "https://supplier.invalid",
      },
    });
    expect(preview.partners[0].sourceRefs[0].rawValues).not.toHaveProperty("B");
    source.rows[0].cells.AC = "ホームページ";
    expect(() => previewPartnerImport(source, productionMapping)).toThrow(
      "見出し",
    );
    source.rows[0].cells.A = "変更した見出し";
    expect(() => previewPartnerImport(source, productionMapping)).toThrow(
      "見出し",
    );
  });
  it("handles quoted CSV, BOM, multiline fields and preserves raw text", () => {
    const parsed = parseCSVRows(
      '\uFEFF会社名,品目\r\n"会社,Ａ","複数\n行 ""引用"""\r\n',
    );
    expect(parsed[0].cells.A).toBe("会社名");
    expect(parsed[1].cells).toEqual({ A: "会社,Ａ", B: '複数\n行 "引用"' });
    expect(() => parseCSVRows('A\n"open')).toThrow();
  });
  it("resolves explicit headers, keeps equipment groups separate, and never guesses units", () => {
    const source = table(
      "会社,工程,設備,材質,最大外径,全長,数量,納期,設備ID\n設備会社,旋盤,旋盤A,SUS304,300,400,20,2026-12-10,A\n設備会社,切削,旋盤B,アルミ,600,100,10,2026-12-12,B\n",
    );
    const configured: PartnerMapping = {
      headerRow: 1,
      columns: { name: "会社" },
      capabilities: [
        {
          column: "工程",
          field: "process",
          group: "machine",
          groupColumn: "設備ID",
          kind: "processing",
        },
        {
          column: "設備",
          field: "equipment",
          group: "machine",
          groupColumn: "設備ID",
          kind: "processing",
        },
        {
          column: "材質",
          field: "material",
          group: "machine",
          groupColumn: "設備ID",
          kind: "processing",
        },
        {
          column: "最大外径",
          field: "dimension",
          group: "machine",
          groupColumn: "設備ID",
          kind: "processing",
          numeric: true,
          axis: "outer_diameter",
          unit: "mm",
          bound: "max",
        },
        {
          column: "全長",
          field: "dimension",
          group: "machine",
          groupColumn: "設備ID",
          kind: "processing",
        },
        {
          column: "数量",
          field: "quantity",
          group: "machine",
          groupColumn: "設備ID",
          kind: "processing",
          numeric: true,
          unit: "個",
          bound: "max",
        },
        {
          column: "納期",
          field: "delivery",
          group: "machine",
          groupColumn: "設備ID",
          kind: "processing",
          dateBound: "latest",
        },
      ],
    };
    const preview = previewPartnerImport(source, configured);
    expect(preview.valid).toBe(true);
    expect(preview.partners).toHaveLength(1);
    expect(preview.partners[0].groups).toHaveLength(2);
    expect(preview.partners[0].groups[0]).toMatchObject({
      equipment: ["旋盤A"],
      dimensions: { outer_diameter: { max: 300, unit: "mm" } },
      quantity: { max: 20, unit: "個" },
      requiredDate: { latest: "2026-12-10" },
    });
    expect(preview.partners[0].groups[0].dimensions).not.toHaveProperty(
      "overall_length",
    );
    expect(preview.partners[0].groups[0].facts).toContainEqual({
      field: "dimension",
      text: "400",
    });
    const invalid = {
      ...configured,
      capabilities: [{ ...configured.capabilities![3], unit: undefined }],
    };
    expect(() => previewPartnerImport(source, invalid)).toThrow("unit");
    const badValue = structuredClone(source);
    badValue.rows[1].cells.E = "φ300";
    const unknown = previewPartnerImport(badValue, configured);
    expect(unknown.valid).toBe(true);
    expect(unknown.unconfirmed).toHaveLength(1);
    expect(unknown.partners[0].groups[0].dimensions ?? {}).not.toHaveProperty(
      "outer_diameter",
    );
  });
  it("rejects mixed-unit bounds without relabelling the first value", () => {
    const source = table("会社,最小径,最大径\n設備会社,2,30\n");
    const configured: PartnerMapping = {
      columns: { name: "会社" },
      capabilities: [
        {
          column: "最小径",
          field: "dimension",
          group: "machine",
          kind: "processing",
          axis: "outer_diameter",
          bound: "min",
          unit: "cm",
          numeric: true,
        },
        {
          column: "最大径",
          field: "dimension",
          group: "machine",
          kind: "processing",
          axis: "outer_diameter",
          bound: "max",
          unit: "mm",
          numeric: true,
        },
      ],
    };
    const preview = previewPartnerImport(source, configured);
    expect(preview.valid).toBe(false);
    expect(preview.conflicts).toHaveLength(1);
    expect(preview.partners[0].groups[0].dimensions?.outer_diameter).toEqual({
      min: 2,
      unit: "cm",
    });
    expect(preview.partners[0].groups[0].facts).toEqual([
      {
        field: "dimension",
        text: "2",
        axis: "outer_diameter",
        bound: "min",
        unit: "cm",
      },
      {
        field: "dimension",
        text: "30",
        axis: "outer_diameter",
        bound: "max",
        unit: "mm",
      },
    ]);
    expect(() => buildPartnerImportSQL(preview, 0, 0)).toThrow("競合");
  });
  it("rejects contradictory values for the same bound without overwriting either fact", () => {
    const source = table("会社,最大径A,最大径B\n設備会社,300,500\n");
    const configured: PartnerMapping = {
      columns: { name: "会社" },
      capabilities: ["最大径A", "最大径B"].map((column) => ({
        column,
        field: "dimension",
        group: "machine",
        kind: "processing",
        axis: "outer_diameter",
        bound: "max",
        unit: "mm",
        numeric: true,
      })),
    };
    const preview = previewPartnerImport(source, configured);
    expect(preview.valid).toBe(false);
    expect(preview.conflicts).toHaveLength(1);
    expect(preview.partners[0].groups[0].dimensions?.outer_diameter).toEqual({
      max: 300,
      unit: "mm",
    });
    expect(
      preview.partners[0].groups[0].facts?.map((fact) => fact.text),
    ).toEqual(["300", "500"]);
    expect(preview.partners[0].sourceRefs[0].rawValues).toMatchObject({
      B: "300",
      C: "500",
    });
    expect(() => buildPartnerImportSQL(preview, 0, 0)).toThrow("競合");
  });
  it.each(["mapped", "legacy"])(
    "drops a removed source URL when remaining evidence has no URL (%s)",
    (mode) => {
      const sourceA = { ...mapping, sourceKey: "source-with-url" };
      const sourceB = { ...mapping, sourceKey: "source-without-url" };
      const first = previewPartnerImport(
        table("名,品,HP\n残存会社,リング,https://removed-source.invalid\n"),
        sourceA,
      );
      const second = previewPartnerImport(
        table("名,品,HP\n残存会社,リング,\n"),
        sourceB,
        first.partners,
      );
      expect(second.partners[0].website).toBe("https://removed-source.invalid");
      if (mode === "legacy") {
        for (const ref of second.partners[0].sourceRefs.filter(
          (ref) => ref.sourceKey === sourceB.sourceKey,
        )) {
          delete ref.columns;
          delete ref.rawValues;
        }
      }
      const refreshed = previewPartnerImport(
        table("名,品,HP\n別会社,板,\n"),
        sourceA,
        second.partners,
      );
      expect(refreshed.valid).toBe(true);
      const remaining = refreshed.partners.find(
        (partner) => partner.name === "残存会社",
      );
      expect(remaining?.website).toBeNull();
      expect(remaining?.sourceRefs.map((ref) => ref.sourceKey)).toEqual([
        sourceB.sourceKey,
      ]);
      expect(
        remaining?.groups[0].sourceRefs?.map((ref) => ref.sourceKey),
      ).toEqual([sourceB.sourceKey]);
    },
  );
  it("keeps other logical sources and removes obsolete conditions only from the refreshed source", () => {
    const sourceA = { ...mapping, sourceKey: "sourceA" };
    const sourceB = { ...mapping, sourceKey: "sourceB" };
    const first = previewPartnerImport(
      table("名,品,HP\n会社A,リング,\n会社B,板,\n"),
      sourceA,
    );
    const second = previewPartnerImport(
      table("名,品,HP\n会社C,丸棒,\n"),
      sourceB,
      first.partners,
    );
    expect(second.counts.partners).toBe(3);
    const refreshed = previewPartnerImport(
      table("名,品,HP\n会社A,パイプ,\n"),
      sourceA,
      second.partners,
    );
    expect(refreshed.counts.partners).toBe(2);
    expect(
      refreshed.partners
        .find((partner) => partner.name === "会社A")
        ?.groups.flatMap((group) => group.products ?? []),
    ).toEqual(["パイプ"]);
    expect(
      refreshed.partners.find((partner) => partner.name === "会社C"),
    ).toBeDefined();
    expect(refreshed.changes.removed).toEqual([first.partners[1].id]);
    const repeated = previewPartnerImport(
      table("名,品,HP\n会社A,パイプ,\n"),
      sourceA,
      refreshed.partners,
    );
    expect(repeated.noop).toBe(true);
    expect(buildPartnerImportSQL(repeated, 1, 1).statements).toEqual([]);
  });
  it("keeps only mapped source values and resolves HP as a header before Excel column syntax", () => {
    const preview = previewPartnerImport(
      table(
        "仕入先,取扱い品,HP,月別金額\n会社,リング,https://supplier.invalid,999999\n",
      ),
      { columns: { name: "仕入先", item: "取扱い品", website: "HP" } },
    );
    expect(preview.resolvedColumns.website).toBe("C");
    expect(preview.partners[0].sourceRefs[0].rawValues).not.toHaveProperty("D");
  });
  it("flags ambiguous same-name rows and previews added/changed/disappeared records", () => {
    const prior = previewPartnerImport(
      table("名,品,HP\n会社A,リング,\n会社B,板,\n"),
      mapping,
    );
    const next = previewPartnerImport(
      table("名,品,HP\n会社A,丸棒,\n会社C,板,\n"),
      mapping,
      prior.partners,
    );
    expect(next.changes.added).toHaveLength(1);
    expect(next.changes.changed).toEqual([prior.partners[0].id]);
    expect(next.changes.removed).toEqual([prior.partners[1].id]);
    const duplicate = previewPartnerImport(
      table("名,品,HP\n会社A,リング,\n会社 A,板,\n"),
      mapping,
    );
    expect(duplicate.valid).toBe(false);
    expect(duplicate.ambiguities).toHaveLength(1);
    expect(() => buildPartnerImportSQL(duplicate, 0, 0)).toThrow();
  });
  it("switches versions and knowledge atomically, rolls back failures and blocks stale writes", async () => {
    expect((await loadPartnerMaster({ DB: db })).status).toBe("unavailable");
    const preview = previewPartnerImport(
      table("名,品,HP\n会社A,リング,\n一覧会社,,\n"),
      mapping,
    );
    const plan = buildPartnerImportSQL(preview, 0, 0);
    await applyPartnerImport(db, plan);
    const first = await loadPartnerMaster({ DB: db });
    expect(first).toMatchObject({
      status: "ready",
      versionId: plan.versionId,
      revision: 1,
    });
    expect(
      await db.prepare("SELECT revision FROM knowledge WHERE id=1").first(),
    ).toEqual({ revision: 1 });
    const next = previewPartnerImport(
      table("名,品,HP\n会社A,板,\n"),
      mapping,
      first.partners,
    );
    const broken = buildPartnerImportSQL(next, 1, 1);
    broken.statements.splice(3, 0, "INSERT INTO missing_table VALUES(1)");
    await expect(applyPartnerImport(db, broken)).rejects.toThrow();
    expect((await loadPartnerMaster({ DB: db })).versionId).toBe(
      plan.versionId,
    );
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM partner_master_versions")
        .first(),
    ).toEqual({ n: 1 });
    await expect(
      applyPartnerImport(db, buildPartnerImportSQL(next, 0, 0)),
    ).rejects.toThrow();
    const state = await readCurrentPartnerImport(db);
    await failPartnerImport(db, state);
    expect((await loadPartnerMaster({ DB: db })).status).toBe("unavailable");
    expect((await readCurrentPartnerImport(db)).current_version_id).toBe(
      plan.versionId,
    );
    await applyPartnerImport(db, buildPartnerImportSQL(next, 2, 2));
    expect(await loadPartnerMaster({ DB: db })).toMatchObject({
      status: "ready",
      revision: 3,
    });
    expect(
      await db.prepare("SELECT revision FROM knowledge WHERE id=1").first(),
    ).toEqual({ revision: 3 });
  });
  it("fails closed on corrupt records", async () => {
    const state = await readCurrentPartnerImport(db);
    await db
      .prepare("UPDATE partner_master_rows SET json='{}' WHERE version_id=?")
      .bind(state.current_version_id)
      .run();
    expect(await loadPartnerMaster({ DB: db })).toMatchObject({
      status: "unavailable",
      partners: [],
    });
  });
  it("runs local CLI apply, no-op reapply and failure state against isolated persisted D1", async () => {
    const persistPath = join(directory, "d1"),
      mappingFile = join(directory, "mapping.json");
    await writeFile(mappingFile, JSON.stringify(mapping));
    let local = await openLocalPartnerDB({ persistPath });
    const sql = await Promise.all(
      ["0001.sql", "0005_partner_master.sql"].map((name) =>
        readFile("migrations/" + name, "utf8"),
      ),
    );
    await local.db.exec(
      sql
        .join("\n")
        .replace(/--[^\n]*/g, "")
        .replace(/\n/g, " "),
    );
    await local.close();
    const args = [
      "scripts/import-partners.mjs",
      "--file",
      "tests/fixtures/partner-master/suppliers.csv",
      "--mapping",
      mappingFile,
      "--persist-path",
      persistPath,
      "--apply",
    ];
    const applied = execFileSync(process.execPath, args, { encoding: "utf8" });
    expect(applied).toContain('"applied":true');
    const noop = execFileSync(process.execPath, args, { encoding: "utf8" });
    expect(noop).toContain('"noop":true');
    local = await openLocalPartnerDB({ persistPath });
    expect(
      await local.db
        .prepare("SELECT revision FROM knowledge WHERE id=1")
        .first(),
    ).toEqual({ revision: 1 });
    await local.close();
    await writeFile(mappingFile, JSON.stringify({ ...mapping, columns: {} }));
    expect(() =>
      execFileSync(process.execPath, args, { stdio: "pipe" }),
    ).toThrow();
    local = await openLocalPartnerDB({ persistPath });
    expect(await loadPartnerMaster({ DB: local.db })).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("最新取込が失敗"),
    });
    expect((await readCurrentPartnerImport(local.db)).partners).toHaveLength(2);
    await local.close();
    expect(() =>
      execFileSync(
        process.execPath,
        ["scripts/import-partners.mjs", "--remote"],
        { stdio: "pipe" },
      ),
    ).toThrow();
  });
});
