import { ownedDrillingRequest } from "../domain/grounding";
import { recoverExplicitTurn } from "./explicit-intake";
import type { Snapshot } from "../domain/model";

/** Reparse an untouched failed opening, including repeated requests for the same drilling work. */
export function restoreOpeningTurn(s: Snapshot): Snapshot | null {
  const event = s.inputs[0];
  if (
    !s.extractionFailed ||
    ![
      "MODEL_TIMEOUT",
      "INVALID_EXTRACTION",
      "MODEL_UNAVAILABLE",
      "MODEL_RESULT_UNKNOWN",
    ].includes(s.extractionError ?? "") ||
    s.brief.items.length ||
    s.brief.attachmentRefs.length ||
    s.overflow.length ||
    !event ||
    s.unresolvedInputs?.length !== s.inputs.length ||
    s.pendingChanges?.length ||
    !s.inputs.every(
      (input, index) =>
        input.type === "customer_text" &&
        !s.unresolvedInputs?.[index].partialFor &&
        s.unresolvedInputs?.[index].id === input.id &&
        s.unresolvedInputs[index].text === input.text,
    )
  )
    return null;
  if (s.inputs.length > 1) {
    const request = ownedDrillingRequest(event.text);
    if (
      !request ||
      !s.inputs.every(
        (input) => ownedDrillingRequest(input.text)?.item === request.item,
      )
    )
      return null;
  }
  const restored = recoverExplicitTurn(
    { ...s, inputs: [], unresolvedInputs: [], pendingChanges: [] },
    event.text,
    null,
    event.id,
  );
  if (!restored) return null;
  restored.inputs = s.inputs.map((input) => ({ ...input }));
  return restored;
}
