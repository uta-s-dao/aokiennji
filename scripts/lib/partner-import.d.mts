import type { PartnerRecord } from "../../src/domain/partner-search";
export type PartnerTable = {
  fileName: string;
  sourceId: string;
  sheet: string;
  rows: { row: number; cells: Record<string, string> }[];
};
export type CapabilityMapping = {
  column: string | number;
  field:
    | "item"
    | "model"
    | "manufacturer"
    | "process"
    | "equipment"
    | "material"
    | "dimension"
    | "quantity"
    | "hole_count"
    | "delivery";
  group: string;
  groupColumn?: string | number;
  kind: "processing" | "purchase";
  separator?: string;
  numeric?: boolean;
  axis?: string;
  bound?: "min" | "max" | "exact";
  unit?: string;
  dateBound?: "earliest" | "latest";
};
export type PartnerMapping = {
  sheet?: string;
  sourceKey?: string;
  encoding?: string;
  headerRow?: number;
  columns: Record<string, string | number>;
  capabilities?: CapabilityMapping[];
  identityAliases?: Record<string, string>;
  expectedHeaders?: Record<string, string>;
};
export type ImportPreview = {
  noop: boolean;
  valid: boolean;
  source: {
    sourceId: string;
    sourceKey: string;
    fileName: string;
    sheet: string;
  };
  mapping: PartnerMapping;
  resolvedColumns: Record<string, string>;
  columnLabels: Record<string, string>;
  contentDigest: string;
  partners: PartnerRecord[];
  rawRows: unknown[];
  skipped: unknown[];
  conflicts: unknown[];
  ambiguities: unknown[];
  unconfirmed: unknown[];
  changes: {
    added: string[];
    changed: string[];
    unchanged: string[];
    removed: string[];
  };
  counts: { partners: number; documented: number; listOnly: number };
};
export function digest(value: string | Uint8Array): string;
export function normalizeName(value: string): string;
export function parseCSVRows(text: string): PartnerTable["rows"];
export function readPartnerFile(
  file: string,
  mapping: PartnerMapping,
): Promise<PartnerTable>;
export function previewPartnerImport(
  table: PartnerTable,
  mapping: PartnerMapping,
  previous?: PartnerRecord[],
): ImportPreview;
export function buildPartnerImportSQL(
  preview: ImportPreview,
  expectedRevision: number,
  expectedKnowledgeRevision: number,
  versionId?: string,
): { versionId: string | null; statements: string[] };
