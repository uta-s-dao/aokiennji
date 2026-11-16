const LIMIT_MICRO_USD = 1000000;
const MAX_CALLS = 40;
const PRICES = {
  "gpt-5.6-terra": { input: 2.5, output: 12 },
  // Above Luna's Standard/cache-write rates; retain margin for regional processing.
  "gpt-6-luna": { input: 0.3, output: 0.75 },
};
function reserveBudget(
  report,
  { id, inputTokens, maxOutputTokens, model = "gpt-5.6-terra" },
) {
  if (!Object.hasOwn(PRICES, model)) throw new Error("UNPRICED_MODEL");
  const price = PRICES[model];
  if (
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    inputTokens > 240000 ||
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens < 1 ||
    maxOutputTokens > 4096
  )
    throw new Error("INVALID_TOKEN_BOUND");
  if (report.calls.some((c) => c.id === id))
    throw new Error("CALL_ALREADY_RESERVED");
  if (report.calls.length >= MAX_CALLS) throw new Error("CALL_LIMIT");
  // Count all input at the cache-write upper rate; allow 10% + 64 input tokens for counting differences.
  const inputUpperBound = Math.ceil(inputTokens * 1.1) + 64;
  const reservedMicroUsd = Math.ceil(
    inputUpperBound * price.input + maxOutputTokens * price.output,
  );
  const used = report.calls.reduce((sum, c) => sum + c.reservedMicroUsd, 0);
  if (used + reservedMicroUsd > LIMIT_MICRO_USD) throw new Error("COST_LIMIT");
  const reservation = {
    id,
    inputTokensCounted: inputTokens,
    inputUpperBound,
    maxOutputTokens,
    reservedMicroUsd,
    state: "reserved",
    reservedAt: new Date().toISOString(),
    model,
    priceUpperPerMillionUsd: price,
  };
  report.calls.push(reservation);
  return reservation;
}
module.exports = { reserveBudget, LIMIT_MICRO_USD, MAX_CALLS, PRICES };
