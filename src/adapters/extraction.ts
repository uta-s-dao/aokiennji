import { extractDemoDialogue } from "./demo-dialogue";
import { unresolvedKeys } from "../domain/dialogue";
import {
  id,
  AppError,
  type Snapshot,
  type Question,
  type InputEvent,
} from "../domain/model";
export type Extractor = {
  extract: (
    s: Snapshot,
    text: string,
    q: Question | null,
    signal?: AbortSignal,
  ) => Promise<Snapshot>;
};
// Local demonstration only. This is not an LLM or an assertion of extraction accuracy.
export function extractDemo(
  s: Snapshot,
  text: string,
  q: Question | null = null,
): Snapshot {
  return extractDemoDialogue(s, text, q);
}
export class DisabledExtractor implements Extractor {
  async extract(): Promise<Snapshot> {
    throw new AppError("MODEL_DISABLED");
  }
}
export const demoExtractor: Extractor = {
  extract: async (s, text, q) => extractDemo(s, text, q),
};

export const DEFAULT_EXTRACTION_TIMEOUT_MS = 3000;

/** One extraction attempt, bounded independently of the provider. Never regenerate on failure. */
export async function extractOnce(
  extractor: Extractor,
  s: Snapshot,
  text: string,
  q: Question | null,
  timeoutMs = DEFAULT_EXTRACTION_TIMEOUT_MS,
): Promise<Snapshot> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    const result = await Promise.race([
      extractor.extract(structuredClone(s), text, q, controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("MODEL_TIMEOUT"));
        }, timeoutMs);
      }),
    ]);
    if (result.extractionFailed)
      throw new AppError(result.extractionError ?? "INVALID_EXTRACTION");
    result.extractionError = undefined;
    return result;
  } catch (error) {
    const fallback = structuredClone(s);
    fallback.extractionFailed = true;
    const event: InputEvent = { id: id(), text, type: "customer_text" };
    fallback.inputs.push(event);
    fallback.unresolvedInputs = [...(s.unresolvedInputs ?? []), event];
    const target =
      s.brief.items.find((i) => i.id === q?.itemId) ??
      (s.brief.items.length === 1 ? s.brief.items[0] : undefined);
    if (target)
      fallback.pendingChanges = [
        ...(s.pendingChanges ?? []),
        ...unresolvedKeys(text).map((key) => ({
          eventId: event.id,
          itemId: target.id,
          key,
        })),
      ];
    fallback.extractionError = controller.signal.aborted
      ? "MODEL_TIMEOUT"
      : error instanceof Error &&
          [
            "MODEL_DISABLED",
            "MODEL_TIMEOUT",
            "MODEL_RATE_LIMITED",
            "MODEL_AUTH_FAILED",
            "INVALID_EXTRACTION",
            "MODEL_REFUSED",
          ].includes(error.message)
        ? error.message
        : "MODEL_UNAVAILABLE";
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}
