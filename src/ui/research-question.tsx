import { useState } from "react";
import { fields } from "../domain/fields";
import type {
  ResearchFollowupAnswer,
  toPublicResearchFollowup,
} from "../domain/research-followup";

export type ResultQuestion = ReturnType<typeof toPublicResearchFollowup> & {
  jobId: string;
};

export function ResearchQuestion({
  offer,
  itemLabel,
  busy,
  onAnswer,
}: {
  offer: ResultQuestion;
  itemLabel?: string;
  busy: boolean;
  onAnswer: (answer: ResearchFollowupAnswer) => void;
}) {
  const [value, setValue] = useState("");
  const units = fields[offer.fieldKey]?.units;
  const [unit, setUnit] = useState(units?.[0] ?? "");
  return (
    <section className="question-card" aria-labelledby="result-question">
      {itemLabel && <p>{itemLabel}について</p>}
      <h2 id="result-question">{offer.question}</h2>
      <p>{offer.reason}</p>
      {offer.kind === "clarify_field" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const text = value.trim();
            if (
              !text ||
              (units && (!Number.isFinite(Number(text)) || Number(text) <= 0))
            )
              return;
            onAnswer({
              status: "known",
              value: {
                text: text + unit,
                number: units ? Number(text) : null,
                unit: unit || null,
              },
            });
          }}
        >
          <label htmlFor="result-answer">
            {fields[offer.fieldKey]?.label ?? "回答"}
          </label>
          <input
            id="result-answer"
            required
            disabled={busy}
            maxLength={300}
            type={
              units
                ? "number"
                : offer.fieldKey === "required_date"
                  ? "date"
                  : "text"
            }
            step={units ? "any" : undefined}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          {units && (
            <select
              aria-label="単位"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              disabled={busy}
            >
              {units.map((u) => (
                <option key={u}>{u}</option>
              ))}
            </select>
          )}
          <button className="primary" disabled={busy || !value.trim()}>
            条件を追加して再調査
          </button>
        </form>
      )}
      <div className="actions">
        {offer.options.map((option) => (
          <button
            key={option.value}
            disabled={busy}
            onClick={() =>
              onAnswer(
                option.value === "unknown" || option.value === "skipped"
                  ? { status: option.value }
                  : { status: "known", choice: option.value },
              )
            }
          >
            {option.label}
          </button>
        ))}
      </div>
    </section>
  );
}
