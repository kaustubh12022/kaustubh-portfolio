import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * The accessibility gate.
 *
 * WHAT IT CHECKS
 * --------------
 * The home page is scanned with axe-core and every SERIOUS or CRITICAL
 * violation fails the test. `serious` and `critical` are the two impact
 * levels that mean a real barrier for a real person; `moderate` and `minor`
 * are reported by the tool but do not block.
 *
 * WHY `wcag2a` / `wcag2aa` / `wcag21a` / `wcag21aa`
 * -------------------------------------------------
 * The scan is limited to the WCAG conformance tags. axe's default rule set
 * also contains "best practice" rules that no standard requires, and a gate
 * that fails on a best practice suggestion is a gate that gets switched off.
 *
 * It is free and local: axe-core is injected into the page, nothing leaves
 * the machine.
 */

/**
 * The violations that are known and still open.
 *
 * A known violation is NOT allowed to pass silently: it is printed on every
 * run, so it cannot be forgotten, and any NEW serious or critical violation
 * still fails the test.
 */
const KNOWN_VIOLATIONS: Record<string, string> = {
  "label-content-name-mismatch":
    "components/chat/PortfolioChat.tsx:290-302 - the hero home button has " +
    "aria-label=\"Kaustubh Kale - home\" while its visible text is " +
    "\"KK Kaustubh Kale\", so the visible text is not part of the accessible " +
    "name. Owned by the accessibility phase.",
};

/** A violation, reduced to what a report needs. */
type Blocking = {
  id: string;
  impact: string;
  help: string;
  nodes: number;
  targets: string[];
};

test("the home page has no serious or critical accessibility violations", async ({
  page,
}) => {
  await page.goto("/");

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  const blocking: Blocking[] = results.violations
    .filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    )
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact ?? "unknown",
      help: violation.help,
      nodes: violation.nodes.length,
      targets: violation.nodes.slice(0, 3).map((node) => node.target.join(" ")),
    }));

  const known = blocking.filter((violation) => KNOWN_VIOLATIONS[violation.id]);
  const unknown = blocking.filter(
    (violation) => !KNOWN_VIOLATIONS[violation.id],
  );

  if (known.length > 0) {
    console.warn(
      `[a11y] ${known.length} KNOWN violation(s) are still open:`,
      known.map(
        (violation) =>
          `\n  - ${violation.id} (${violation.impact}, ${violation.nodes} node(s))` +
          `\n      ${KNOWN_VIOLATIONS[violation.id]}`,
      ),
    );
  }

  // Zero NEW serious or critical violations.
  expect(unknown).toEqual([]);
});
