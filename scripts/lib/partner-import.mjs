/* global structuredClone */
import { TextDecoder } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { basename, extname } from "node:path";
import { fileURLToPath } from "node:url";

export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export const normalizeName = (value) =>
  value
    .normalize("NFKC")
    .replace(/[\s\u3000]/g, "")
    .toLowerCase();
const normalizeText = (value) =>
  String(value ?? "")
    .normalize("NFKC")
    .trim();
const columnName = (index) => {
  let out = "";
  for (let n = index + 1; n; n = Math.floor((n - 1) / 26))
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  return out;
};

export function parseCSVRows(text) {
  const rows = [];
  let row = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (char === "," || char === "\n")) {
      row.push(cell.replace(/\r$/, ""));
      cell = "";
      if (char === "\n") {
        rows.push(row);
        row = [];
      }
    } else cell += char;
  }
  if (quoted) throw new Error("CSVの引用符が閉じていません");
  if (cell || row.length) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  if (rows[0]?.[0]) rows[0][0] = rows[0][0].replace(/^\uFEFF/, "");
  return rows.map((cells, index) => ({
    row: index + 1,
    cells: Object.fromEntries(cells.map((value, i) => [columnName(i), value])),
  }));
}

export async function readPartnerFile(file, mapping) {
  const bytes = await readFile(file),
    extension = extname(file).toLowerCase();
  let table;
  if (extension === ".csv")
    table = {
      sheet: mapping.sheet ?? "CSV",
      rows: parseCSVRows(
        new TextDecoder(mapping.encoding ?? "utf-8", { fatal: true }).decode(
          bytes,
        ),
      ),
    };
  else if (extension === ".xlsx") {
    if (!mapping.sheet) throw new Error("XLSXはsheetの指定が必要です");
    table = JSON.parse(
      execFileSync(
        "python3",
        [
          fileURLToPath(new URL("./read-partner-xlsx.py", import.meta.url)),
          file,
          mapping.sheet,
        ],
        { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
      ),
    );
  } else throw new Error("CSVまたはXLSXを指定してください");
  return {
    ...table,
    fileName: basename(file),
    sourceId: "source_" + digest(bytes).slice(0, 24),
  };
}

function resolveColumn(value, header) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1)
    return columnName(value - 1);
  if (typeof value !== "string" || !value)
    throw new Error(
      "列はExcel列記号、1始まり番号、または見出し名で指定してください",
    );
  const matches = Object.entries(header).filter(
    ([, text]) => normalizeText(text) === value,
  );
  if (matches.length === 0 && /^[A-Z]+$/.test(value)) return value;
  if (matches.length !== 1)
    throw new Error(`見出しの列が一意に決まりません: ${value}`);
  return matches[0][0];
}
function semanticGroup({
  source: _source,
  sourceRefs: _sourceRefs,
  evidence: _evidence,
  ...group
}) {
  return group;
}
function semantic(record) {
  return {
    name: normalizeName(record.name),
    website: normalizeText(record.website ?? "").replace(/\/$/, ""),
    groups: record.groups
      .map(semanticGroup)
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}
const sourceKeyOf = (ref) => ref.sourceKey ?? `${ref.fileName}#${ref.sheet}`;
const groupRefs = (group) =>
  group.sourceRefs ?? (group.source ? [group.source] : []);
const stableRecords = (records) =>
  records
    .map((record) => ({
      ...record,
      groups: record.groups
        .map((group) => {
          const refs = [...groupRefs(group)].sort((a, b) =>
            JSON.stringify(a).localeCompare(JSON.stringify(b)),
          );
          return { ...group, source: refs[0], sourceRefs: refs };
        })
        .sort((a, b) => a.id.localeCompare(b.id)),
      sourceRefs: [...record.sourceRefs].sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      ),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

function excluded(name) {
  return (
    !name ||
    /^(?:[○〇◯●\s]+|合計|総合計|総計|小計)$/.test(name) ||
    /(?:小計|合計)$/.test(name) ||
    /^(?:仕入先|仕入先名|会社名|取引先名)$/.test(name)
  );
}
const factsFields = new Set([
  "item",
  "model",
  "manufacturer",
  "process",
  "equipment",
  "material",
  "dimension",
  "quantity",
  "hole_count",
  "delivery",
]);
const dimensions = new Set([
  "overall_length",
  "outer_diameter",
  "inner_diameter",
  "opening_diameter",
  "hole_diameter",
  "width",
  "height",
  "depth",
  "thickness",
]);

/** Mapping is always explicit. A capability column belongs to one condition group. */
export function previewPartnerImport(table, mapping, previous = []) {
  if (!mapping.columns?.name) throw new Error("columns.nameを指定してください");
  const headerRow = mapping.headerRow ?? 1;
  if (!Number.isInteger(headerRow) || headerRow < 0)
    throw new Error("headerRowは0以上の整数です");
  const sourceKey = mapping.sourceKey ?? `${table.fileName}#${table.sheet}`;
  if (typeof sourceKey !== "string" || !sourceKey.trim())
    throw new Error("sourceKeyが空です");
  const header = table.rows.find((row) => row.row === headerRow)?.cells ?? {};
  const columns = Object.fromEntries(
    Object.entries(mapping.columns).map(([key, value]) => [
      key,
      resolveColumn(value, header),
    ]),
  );
  for (const [field, expected] of Object.entries(
    mapping.expectedHeaders ?? {},
  )) {
    if (!columns[field] || normalizeText(header[columns[field]]) !== expected)
      throw new Error(`見出しの検証に失敗しました: ${field}`);
  }
  const capabilities = (mapping.capabilities ?? []).map((spec, index) => {
    if (!factsFields.has(spec.field))
      throw new Error(`能力列fieldが不正です: ${spec.field}`);
    if (!spec.group || !["processing", "purchase"].includes(spec.kind))
      throw new Error("能力列は明示したgroupとkindが必要です");
    if (spec.axis && !dimensions.has(spec.axis))
      throw new Error("寸法axisが不正です");
    if (spec.axis && spec.field !== "dimension")
      throw new Error("寸法axisはdimension列だけに指定できます");
    if (spec.bound && !["min", "max", "exact"].includes(spec.bound))
      throw new Error("boundが不正です");
    if (
      spec.numeric &&
      !["dimension", "quantity", "hole_count"].includes(spec.field)
    )
      throw new Error("numericは寸法・数量・穴数のみです");
    if (
      spec.field === "dimension" &&
      spec.numeric &&
      (!spec.axis || !spec.unit || !spec.bound)
    )
      throw new Error("数値寸法にはaxis,unit,boundが必要です");
    if (
      spec.field === "quantity" &&
      spec.numeric &&
      (!spec.unit || !spec.bound)
    )
      throw new Error("数値数量にはunit,boundが必要です");
    if (
      spec.numeric &&
      ["opening_diameter", "hole_diameter"].includes(spec.axis) &&
      !["mm", "cm", "m"].includes(spec.unit)
    )
      throw new Error("穴径・開口径には長さのunitが必要です");
    if (
      spec.field === "hole_count" &&
      spec.numeric &&
      (!spec.bound || !["か所", "箇所", "個", "穴"].includes(spec.unit))
    )
      throw new Error("数値穴数には穴数のunit,boundが必要です");
    if (
      spec.dateBound &&
      (spec.field !== "delivery" ||
        !["earliest", "latest"].includes(spec.dateBound))
    )
      throw new Error("dateBoundはdeliveryのearliest/latestを指定してください");
    const column = resolveColumn(spec.column, header);
    columns[`capability.${index}`] = column;
    const groupColumn = spec.groupColumn
      ? resolveColumn(spec.groupColumn, header)
      : null;
    if (groupColumn) columns[`capability.${index}.group`] = groupColumn;
    return { ...spec, column, ...(groupColumn ? { groupColumn } : {}) };
  });
  // Keep the column's original heading and the approved interpretation together
  // so later imports never change the meaning displayed for an earlier row.
  const fieldNames = {
    name: "会社名",
    website: "URL",
    item: "取扱品",
    model: "型番",
    manufacturer: "メーカー",
    process: "加工種別",
    equipment: "設備",
    material: "材質",
    dimension: "寸法",
    quantity: "数量",
    hole_count: "穴数",
    delivery: "納期",
  };
  const axisNames = {
    overall_length: "全長",
    outer_diameter: "外径",
    inner_diameter: "内径",
    opening_diameter: "開口径",
    hole_diameter: "穴径",
    height: "高さ",
    width: "幅",
    depth: "奥行",
    thickness: "厚さ",
  };
  const boundNames = {
    min: "下限",
    max: "上限",
    exact: "指定値",
    earliest: "最早日",
    latest: "最遅日",
  };
  const columnLabels = Object.fromEntries(
    Object.entries(columns).map(([key, column]) => {
      const [, index, part] = key.split(".");
      const spec = key.startsWith("capability.")
        ? capabilities[Number(index)]
        : null;
      const meaning = !spec
        ? (fieldNames[key] ?? key)
        : part === "group"
          ? "設備・条件組の識別列"
          : [
              axisNames[spec.axis] ?? fieldNames[spec.field],
              boundNames[spec.bound ?? spec.dateBound],
              spec.unit,
              spec.group,
            ]
              .filter(Boolean)
              .join(" / ");
      return [key, (header[column] || column) + " → " + meaning];
    }),
  );
  const partners = [],
    skipped = [],
    conflicts = [],
    ambiguities = [],
    unconfirmed = [],
    rawRows = [];
  for (const row of table.rows.filter((row) => row.row > headerRow)) {
    const name = normalizeText(row.cells[columns.name]);
    if (excluded(name)) {
      skipped.push({ row: row.row, reason: "空行・見出し・小計・合計・仮名" });
      continue;
    }
    const mappedValues = Object.fromEntries(
      [
        ...new Set([
          ...Object.values(columns),
          ...capabilities
            .filter((spec) => spec.groupColumn)
            .map((spec) => spec.groupColumn),
        ]),
      ].map((column) => [column, row.cells[column] ?? ""]),
    );
    const source = {
      sourceId: table.sourceId,
      sourceKey,
      fileName: table.fileName,
      sheet: table.sheet,
      row: row.row,
      rawValues: mappedValues,
      columnLabels,
      columns,
    };
    const normalizedName = normalizeName(
        mapping.identityAliases?.[name] ?? name,
      ),
      partnerId = "partner_" + digest(normalizedName).slice(0, 24);
    const groups = new Map();
    const ensureGroup = (key, kind) => {
      if (!groups.has(key))
        groups.set(key, {
          id: partnerId + "_" + digest(key).slice(0, 12),
          kind,
          evidence: [],
          facts: [],
          source,
          sourceRefs: [source],
        });
      const group = groups.get(key);
      if (group.kind !== kind)
        throw new Error("同じgroupに異なるkindを指定できません");
      return group;
    };
    const item = normalizeText(row.cells[columns.item]);
    if (item) {
      const group = ensureGroup(
        "item:" + digest(item).slice(0, 16),
        "purchase",
      );
      group.products = [item];
      group.evidence.push(`取扱い品: ${item}`);
      group.facts.push({ field: "item", text: item });
    }
    for (const spec of capabilities) {
      const text = normalizeText(row.cells[spec.column]);
      if (!text) continue;
      const groupSuffix = spec.groupColumn
        ? normalizeText(row.cells[spec.groupColumn])
        : "";
      if (spec.groupColumn && !groupSuffix) {
        ambiguities.push({
          row: row.row,
          reason: "設備・条件組の識別列が空です",
        });
        continue;
      }
      const group = ensureGroup(
        spec.group + (spec.groupColumn ? ":" + groupSuffix : ""),
        spec.kind,
      );
      group.facts.push({
        field: spec.field,
        text,
        ...(spec.unit ? { unit: spec.unit } : {}),
        ...(spec.axis ? { axis: spec.axis } : {}),
        ...(spec.bound ? { bound: spec.bound } : {}),
      });
      group.evidence.push(`${spec.field}: ${text}`);
      const listKey = {
        item: "products",
        process: "processes",
        material: "materials",
        equipment: "equipment",
      }[spec.field];
      if (listKey)
        group[listKey] = [
          ...(group[listKey] ?? []),
          ...(spec.separator
            ? text.split(spec.separator).map(normalizeText).filter(Boolean)
            : [text]),
        ];
      if (spec.numeric) {
        if (
          !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text) ||
          !Number.isFinite(Number(text)) ||
          (spec.field === "hole_count" &&
            (!Number.isInteger(Number(text)) || Number(text) < 0))
        ) {
          unconfirmed.push({
            row: row.row,
            field: spec.field,
            text,
            reason: "非数値は原値を保持し、数値能力は未確認です",
          });
          continue;
        }
        const value = Number(text),
          range =
            spec.bound === "exact"
              ? { min: value, max: value, unit: spec.unit }
              : { [spec.bound]: value, unit: spec.unit };
        const priorRange =
          spec.field === "dimension"
            ? group.dimensions?.[spec.axis]
            : spec.field === "hole_count"
              ? group.holeCount
              : group.quantity;
        if (
          priorRange &&
          (priorRange.unit !== range.unit ||
            ["min", "max"].some(
              (bound) =>
                priorRange[bound] !== undefined &&
                range[bound] !== undefined &&
                priorRange[bound] !== range[bound],
            ))
        )
          conflicts.push({
            row: row.row,
            field: spec.field,
            reason: "同じ条件組の単位または範囲が競合しています",
          });
        else if (spec.field === "dimension") {
          group.dimensions ??= {};
          group.dimensions[spec.axis] = { ...priorRange, ...range };
        } else if (spec.field === "quantity")
          group.quantity = { ...priorRange, ...range };
        else if (spec.field === "hole_count")
          group.holeCount = { ...priorRange, ...range };
      }
      if (spec.field === "delivery" && spec.dateBound) {
        if (
          !["earliest", "latest"].includes(spec.dateBound) ||
          !/^\d{4}-\d{2}-\d{2}$/.test(text) ||
          Number.isNaN(Date.parse(text)) ||
          new Date(text).toISOString().slice(0, 10) !== text
        )
          unconfirmed.push({
            row: row.row,
            field: spec.field,
            text,
            reason: "日付は原値を保持し、ISO日付として未確認です",
          });
        else {
          group.requiredDate ??= {};
          group.requiredDate[spec.dateBound] = text;
        }
      }
    }
    const record = {
      id: partnerId,
      name,
      normalizedName,
      website: normalizeText(row.cells[columns.website]) || null,
      capabilityState: groups.size ? "documented" : "list_only",
      groups: [...groups.values()],
      sourceRefs: [source],
    };
    for (const group of record.groups)
      for (const range of [
        ...Object.values(group.dimensions ?? {}),
        ...(group.quantity ? [group.quantity] : []),
        ...(group.holeCount ? [group.holeCount] : []),
      ])
        if (
          range.min !== undefined &&
          range.max !== undefined &&
          range.min > range.max
        )
          conflicts.push({
            row: row.row,
            reason: "能力範囲の最小が最大を超えています",
          });
    rawRows.push({
      row: row.row,
      partnerId,
      name,
      capabilityState: record.capabilityState,
      source,
    });
    const duplicate = partners.find((partner) => partner.id === partnerId);
    if (duplicate) {
      if (
        JSON.stringify(semantic(duplicate)) === JSON.stringify(semantic(record))
      ) {
        duplicate.sourceRefs.push(source);
        for (const group of duplicate.groups) group.sourceRefs.push(source);
      } else if (
        capabilities.some((spec) => spec.groupColumn) &&
        duplicate.website === record.website &&
        record.groups.every(
          (group) =>
            !duplicate.groups.some(
              (prior) =>
                prior.id === group.id &&
                JSON.stringify(semantic({ ...record, groups: [group] })) !==
                  JSON.stringify(semantic({ ...duplicate, groups: [prior] })),
            ),
        )
      ) {
        for (const group of record.groups)
          if (!duplicate.groups.some((prior) => prior.id === group.id))
            duplicate.groups.push(group);
        duplicate.sourceRefs.push(source);
        duplicate.capabilityState = duplicate.groups.length
          ? "documented"
          : "list_only";
      } else
        ambiguities.push({
          partnerId,
          rows: [...duplicate.sourceRefs.map((ref) => ref.row), row.row],
          reason:
            "同名会社の能力またはHPが異なります。名寄せを明示してください",
        });
    } else partners.push(record);
  }
  if (!partners.length) conflicts.push({ reason: "有効な仕入先がありません" });
  // Equivalent snapshots from another format remain independent evidence, even
  // when they belong to the same logical source. Changed groups are never kept.
  for (const record of partners) {
    const prior = previous.find((candidate) => candidate.id === record.id);
    if (
      !prior ||
      normalizeText(prior.website ?? "").replace(/\/$/, "") !==
        normalizeText(record.website ?? "").replace(/\/$/, "")
    )
      continue;
    const preserved = [];
    for (const group of record.groups) {
      const same = prior.groups.find(
        (candidate) =>
          candidate.id === group.id &&
          JSON.stringify(semanticGroup(candidate)) ===
            JSON.stringify(semanticGroup(group)),
      );
      if (!same) continue;
      const historical = groupRefs(same).filter(
        (ref) => sourceKeyOf(ref) === sourceKey,
      );
      group.sourceRefs = [...group.sourceRefs, ...historical].filter(
        (ref, index, refs) =>
          refs.findIndex(
            (other) => JSON.stringify(other) === JSON.stringify(ref),
          ) === index,
      );
      preserved.push(...historical);
    }
    if (!record.groups.length && !prior.groups.length)
      preserved.push(
        ...prior.sourceRefs.filter((ref) => sourceKeyOf(ref) === sourceKey),
      );
    record.sourceRefs = [...record.sourceRefs, ...preserved].filter(
      (ref, index, refs) =>
        refs.findIndex(
          (other) => JSON.stringify(other) === JSON.stringify(ref),
        ) === index,
    );
  }
  // Replace only this logical source. Other files and their condition groups survive.
  const merged = new Map();
  for (const prior of structuredClone(previous)) {
    prior.sourceRefs = prior.sourceRefs.filter(
      (ref) => sourceKeyOf(ref) !== sourceKey,
    );
    // Rebuild metadata from surviving evidence, including legacy rows that may
    // not have a column map. Missing provenance cannot retain a removed URL.
    prior.website =
      prior.sourceRefs
        .map((ref) => normalizeText(ref.rawValues?.[ref.columns?.website]))
        .find(Boolean) ?? null;
    prior.groups = prior.groups.flatMap((group) => {
      const refs = groupRefs(group).filter(
        (ref) => sourceKeyOf(ref) !== sourceKey,
      );
      return refs.length
        ? [{ ...group, source: refs[0], sourceRefs: refs }]
        : [];
    });
    prior.capabilityState = prior.groups.length ? "documented" : "list_only";
    if (prior.sourceRefs.length) merged.set(prior.id, prior);
  }
  for (const record of partners) {
    const prior = merged.get(record.id);
    if (!prior) {
      merged.set(record.id, record);
      continue;
    }
    if (
      prior.website &&
      record.website &&
      normalizeText(prior.website).replace(/\/$/, "") !==
        normalizeText(record.website).replace(/\/$/, "")
    )
      conflicts.push({
        partnerId: record.id,
        reason: "複数資料で同一会社のHPが競合しています",
      });
    prior.website ??= record.website;
    prior.sourceRefs.push(...record.sourceRefs);
    for (const group of record.groups) {
      const existing = prior.groups.find(
        (candidate) => candidate.id === group.id,
      );
      if (!existing) {
        prior.groups.push(group);
        continue;
      }
      if (
        JSON.stringify(semanticGroup(existing)) !==
        JSON.stringify(semanticGroup(group))
      )
        conflicts.push({
          partnerId: record.id,
          groupId: group.id,
          reason: "同じ設備・条件組の能力が複数資料で競合しています",
        });
      else {
        existing.sourceRefs = [...groupRefs(existing), ...groupRefs(group)];
        existing.source = existing.sourceRefs[0];
      }
    }
    prior.capabilityState = prior.groups.length ? "documented" : "list_only";
  }
  partners.splice(0, partners.length, ...merged.values());
  const noop =
    JSON.stringify(stableRecords(partners)) ===
    JSON.stringify(stableRecords(previous));
  const old = new Map(previous.map((partner) => [partner.id, partner]));
  const added = [],
    changed = [],
    unchanged = [];
  for (const partner of partners) {
    const prior = old.get(partner.id);
    (!prior
      ? added
      : JSON.stringify(semantic(partner)) === JSON.stringify(semantic(prior))
        ? unchanged
        : changed
    ).push(partner.id);
    old.delete(partner.id);
  }
  const removed = [...old.keys()];
  const contentDigest = digest(
    JSON.stringify(
      partners.map(semantic).sort((a, b) => a.name.localeCompare(b.name)),
    ),
  );
  return {
    noop,
    valid: !conflicts.length && !ambiguities.length,
    source: {
      sourceId: table.sourceId,
      sourceKey,
      fileName: table.fileName,
      sheet: table.sheet,
    },
    mapping,
    resolvedColumns: columns,
    columnLabels,
    contentDigest,
    partners,
    rawRows,
    skipped,
    conflicts,
    ambiguities,
    unconfirmed,
    changes: { added, changed, unchanged, removed },
    counts: {
      partners: partners.length,
      documented: partners.filter((p) => p.capabilityState === "documented")
        .length,
      listOnly: partners.filter((p) => p.capabilityState === "list_only")
        .length,
    },
  };
}

const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
/** All statements must execute as a single D1 batch/SQLite transaction. */
export function buildPartnerImportSQL(
  preview,
  expectedRevision,
  expectedKnowledgeRevision,
  versionId = "pm_" + randomUUID(),
) {
  if (!preview.valid) throw new Error("競合・曖昧な取込は適用できません");
  if (
    !Number.isInteger(expectedRevision) ||
    !Number.isInteger(expectedKnowledgeRevision)
  )
    throw new Error("revisionが必要です");
  if (preview.noop) return { versionId: null, statements: [] };
  const guard = "pm_guard_" + randomUUID();
  const statements = [
    `INSERT INTO write_guards(id,ok) VALUES(${quote(guard)},EXISTS(SELECT 1 FROM partner_master_state s JOIN knowledge k ON k.id=1 WHERE s.id=1 AND s.revision=${expectedRevision} AND k.revision=${expectedKnowledgeRevision}));`,
    `INSERT INTO partner_master_versions VALUES(${quote(versionId)},'staging',${Date.now()},${quote(preview.contentDigest)},${quote(JSON.stringify(preview.source))},${quote(JSON.stringify(preview.mapping))},${quote(JSON.stringify({ counts: preview.counts, changes: preview.changes }))});`,
    ...preview.partners.map(
      (partner) =>
        `INSERT INTO partner_master_rows VALUES(${quote(versionId)},${quote(partner.id)},${quote(partner.normalizedName)},${quote(JSON.stringify(partner))});`,
    ),
    `UPDATE partner_master_versions SET status='ready' WHERE id=${quote(versionId)};`,
    `UPDATE partner_master_state SET current_version_id=${quote(versionId)},revision=revision+1,last_import_status='ready',last_error=NULL WHERE id=1;`,
    "UPDATE knowledge SET revision=revision+1 WHERE id=1;",
    `DELETE FROM write_guards WHERE id=${quote(guard)};`,
  ];
  return { versionId, statements };
}
