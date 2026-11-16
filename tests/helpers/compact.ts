import type { ExtractionProposal } from "../../src/domain/extraction-proposal";
import type { CompactExtractionProposal } from "../../src/generated/compact-extraction";
import type { Snapshot } from "../../src/domain/model";
import {
  compactFields,
  compactProfiles,
} from "../../src/domain/compact-fields";
// Representation fixtures only. Test assertions still check customer values and downstream behavior.
export function compactFixture(
  p: ExtractionProposal,
  s: Snapshot,
): CompactExtractionProposal {
  const refs = new Map(
    s.brief.items.map((item, index) => [item.id, String(index)]),
  );
  p.newItems.forEach((item, index) => refs.set(item.ref, "n" + (index + 1)));
  return {
    n: p.newItems.map((item) => ({
      i: refs.get(item.ref) as "n1",
      n: item.label,
      q: item.quote,
      p: Object.entries(compactProfiles).find(
        ([, value]) => value === item.profile,
      )![0] as "u",
    })),
    c: p.changes.map((c) => ({
      i: refs.get(c.itemRef) as "0",
      k: Object.entries(compactFields).find(
        ([, key]) => key === c.key,
      )![0] as "mo",
      v: c.value?.text ?? null,
      q: c.quote,
      o: ({ set: "s", correct: "c", hypothetical: "h" } as const)[c.operation],
      h: c.hardConstraint,
    })),
    u: [...p.ambiguities, ...p.unprocessedQuotes],
  };
}
