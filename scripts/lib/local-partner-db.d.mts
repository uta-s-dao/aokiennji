import type { PartnerRecord } from "../../src/domain/partner-search";
export function openLocalPartnerDB(options?: {
  persistPath?: string;
  databaseId?: string;
}): Promise<{ db: D1Database; close: () => Promise<void> }>;
export function readCurrentPartnerImport(
  db: D1Database,
): Promise<{
  current_version_id: string | null;
  last_import_status: string;
  revision: number;
  knowledge_revision: number;
  partners: PartnerRecord[];
}>;
export function applyPartnerImport(
  db: D1Database,
  plan: { statements: string[] },
): Promise<unknown>;
export function failPartnerImport(
  db: D1Database,
  current: { revision: number; knowledge_revision: number },
): Promise<unknown>;
