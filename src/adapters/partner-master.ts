import type { PartnerMaster, PartnerRecord } from "../domain/partner-search";
export type {
  PartnerMaster,
  PartnerRecord,
  PartnerCapability,
  PartnerSourceRef,
} from "../domain/partner-search";

/** Read a single snapshot; never fall back to web candidates on a broken master. */
export async function loadPartnerMaster(env: {
  DB: D1Database;
}): Promise<PartnerMaster> {
  try {
    // One statement prevents a version switch between state and row reads.
    const result = await env.DB.prepare(
      `
      SELECT s.current_version_id, s.revision, s.last_import_status, v.status, v.summary_json, r.json
      FROM partner_master_state s
      LEFT JOIN partner_master_versions v ON v.id=s.current_version_id
      LEFT JOIN partner_master_rows r ON r.version_id=v.id
      WHERE s.id=1 ORDER BY r.partner_id
    `,
    ).all<{
      current_version_id: string | null;
      revision: number;
      status: string | null;
      last_import_status: string;
      json: string | null;
      summary_json: string | null;
    }>();
    const state = result.results[0];
    if (state?.last_import_status === "failed")
      return {
        status: "unavailable",
        versionId: null,
        revision: state.revision,
        partners: [],
        reasonCode: "import_failed",
        reason:
          "協力会社マスタの最新取込が失敗しています。再取込と確認が必要です",
      };
    if (!state?.current_version_id || state.last_import_status === "empty")
      return {
        status: "unavailable",
        versionId: null,
        revision: state?.revision ?? 0,
        partners: [],
        reasonCode: "not_imported",
        reason: "協力会社マスタが未取込です",
      };
    if (state.status !== "ready" || state.last_import_status !== "ready")
      throw new Error("master version is not ready");
    const partners = result.results
      .filter((row) => row.json !== null)
      .map((row) => {
        const partner: PartnerRecord = JSON.parse(row.json!);
        if (
          !partner.id ||
          !partner.name ||
          !Array.isArray(partner.groups) ||
          !Array.isArray(partner.sourceRefs) ||
          !["documented", "list_only"].includes(partner.capabilityState)
        )
          throw new Error("invalid master record");
        if (
          !partner.normalizedName ||
          partner.sourceRefs.length === 0 ||
          partner.sourceRefs.some(
            (ref) =>
              !ref.fileName ||
              typeof ref.sheet !== "string" ||
              !Number.isInteger(ref.row) ||
              ref.row < 1,
          )
        )
          throw new Error("invalid master source");
        if (
          (partner.capabilityState === "documented") !==
          partner.groups.length > 0
        )
          throw new Error("invalid capability state");
        for (const group of partner.groups) {
          if (
            !group.id ||
            !["processing", "purchase"].includes(group.kind) ||
            !Array.isArray(group.evidence) ||
            !group.evidence.some(
              (fact) => typeof fact === "string" && fact.trim(),
            )
          )
            throw new Error("invalid condition group");
          for (const field of [
            group.products,
            group.processes,
            group.materials,
            group.equipment,
          ])
            if (
              field !== undefined &&
              (!Array.isArray(field) ||
                field.some((value) => typeof value !== "string"))
            )
              throw new Error("invalid capability text");
          for (const range of [
            ...Object.values(group.dimensions ?? {}),
            ...(group.quantity ? [group.quantity] : []),
            ...(group.holeCount ? [group.holeCount] : []),
          ]) {
            if (
              !range ||
              !range.unit ||
              (range.min === undefined && range.max === undefined) ||
              (range.min !== undefined && !Number.isFinite(range.min)) ||
              (range.max !== undefined && !Number.isFinite(range.max)) ||
              (range.min !== undefined &&
                range.max !== undefined &&
                range.min > range.max)
            )
              throw new Error("invalid capability range");
          }
        }
        return partner;
      });
    if (
      !partners.length ||
      JSON.parse(state.summary_json ?? "{}").counts?.partners !==
        partners.length
    )
      throw new Error("incomplete master");
    return {
      status: "ready",
      versionId: state.current_version_id,
      revision: state.revision,
      partners,
    };
  } catch {
    return {
      status: "unavailable",
      versionId: null,
      revision: 0,
      partners: [],
      reasonCode: "read_failed",
      reason: "協力会社マスタのDB検索またはデータ読込に失敗しました",
    };
  }
}
