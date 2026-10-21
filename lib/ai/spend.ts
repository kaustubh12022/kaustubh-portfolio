import "server-only";

/**
 * The in-process spend ledger.
 *
 * WHY THIS EXISTS
 * ---------------
 * The account this portfolio runs against had $0.86 remaining after a
 * single afternoon of benchmarking: 516 requests, $0.5156. A per-IP rate
 * limit is not a spend limit - on a multi-instance deploy the effective
 * limit is N times the per-IP limit, and a scripted client ignores it
 * entirely.
 *
 * So the spend itself is capped, in the process, and the cap is
 * configurable. When the ceiling is reached the assistant stops calling the
 * model and answers from the verified content layer instead. A portfolio
 * that says "I am out of budget" is more useful than one that returns a
 * 500.
 *
 * WHY IT LIVES HERE AND NOT IN THE ROUTE
 * ---------------------------------------
 * The health endpoint has to report the spend, and importing a route file
 * from another route file is a fragile pattern. This module is the single
 * place both read from.
 *
 * THE LIMITATION, STATED PLAINLY
 * ------------------------------
 * This is a per-instance counter. It is exact for a single process and an
 * approximation for a fleet. It is a backstop against a runaway loop, a
 * miswritten benchmark, or a scripted client - not a hard billing control.
 * A hard control belongs in the provider's own budget settings, and the
 * owner should set one there.
 */

/** The default ceiling, in USD, for one calendar day. */
export const DEFAULT_DAILY_SPEND_CEILING_USD = 2.0;

/** The spend so far today, in USD. */
let spendToday = 0;

/** The day the counter belongs to, as `YYYY-MM-DD`. */
let spendDay = "";

/**
 * The configured ceiling.
 *
 * `DAILY_SPEND_CEILING_USD` overrides the default. A value of `0` means
 * "never call the model", which is a useful kill switch.
 */
export function dailyCeilingUsd(): number {
  const raw = process.env.DAILY_SPEND_CEILING_USD;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_DAILY_SPEND_CEILING_USD;
}

/** Reset the counter when the calendar day changes. */
function currentDay(): string {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== spendDay) {
    spendDay = today;
    spendToday = 0;
  }
  return today;
}

/** True when today's spend has reached the ceiling. */
export function isOverDailySpendCeiling(): boolean {
  currentDay();
  return spendToday >= dailyCeilingUsd();
}

/** The spend so far today, in USD. */
export function spendTodayUsd(): number {
  currentDay();
  return spendToday;
}

/** The remaining budget today, in USD. Never negative. */
export function spendRemainingUsd(): number {
  return Math.max(0, dailyCeilingUsd() - spendTodayUsd());
}

/** Add to today's spend. */
export function recordSpend(costUsd: number): void {
  currentDay();
  spendToday += costUsd;
}

/** Reset the counter. Used by tests. */
export function resetSpend(): void {
  spendToday = 0;
  spendDay = "";
}
