import type { CapabilityRule, Item } from "./model";
import demoNames from "../../fixtures/demo/classification.json";

// Classification selects candidates only. Decisions still validate the source, approval and all conditions.
export function resolveCategories(
  items: Item[],
  rules: CapabilityRule[],
  time = Date.now(),
): Item[] {
  const active = rules.filter(
    (r) =>
      r.approvalStatus === "approved" &&
      r.approvedAt &&
      Date.parse(r.approvedAt) <= time &&
      r.validUntil &&
      Date.parse(r.validUntil) > time,
  );
  return items.map((item) => {
    const model = item.fields.find(
      (f) => f.key === "model" && f.status === "known",
    )?.value?.text;
    const candidates = new Set(
      active
        .filter(
          (r) =>
            model &&
            r.modelAliases.some((a) => a.toUpperCase() === model.toUpperCase()),
        )
        .map((r) => r.category),
    );
    if (!model) {
      const names = [
        item.label,
        ...item.fields
          .filter(
            (f) =>
              ["description", "product_name"].includes(f.key) &&
              f.status === "known",
          )
          .map((f) => f.value?.text ?? ""),
      ];
      for (const mapping of demoNames)
        if (
          active.some(
            (r) =>
              r.isDemo &&
              r.sourceId === mapping.sourceId &&
              r.category === mapping.category,
          ) &&
          names.some((name) =>
            mapping.names.some((term) => name.includes(term)),
          )
        )
          candidates.add(mapping.category);
    }
    // A model-selected category alone cannot establish a company classification.
    return {
      ...item,
      category: candidates.size === 1 ? [...candidates][0] : null,
    };
  });
}
