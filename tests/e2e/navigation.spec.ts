import { expect, test } from "@playwright/test";

/**
 * The navigation between the project index and a project page.
 */

/**
 * The "Ask about this project" deep link is DEAD.
 *
 * `app/projects/[slug]/page.tsx:519-526` renders
 *
 *   <Link href={`/?q=${encodeURIComponent(question)}`}>
 *
 * but nothing in the app reads `useSearchParams`: `app/page.tsx` renders
 * `<PortfolioChat />` with no search params and `components/chat/PortfolioChat.tsx`
 * never looks at the query string. The question is therefore dropped and
 * the visitor lands on an EMPTY composer.
 *
 * The fix belongs to `app/projects/[slug]/page.tsx` and
 * `components/chat/PortfolioChat.tsx`, which another agent owns, so this
 * test documents the EXPECTED behaviour and is marked as a known failure.
 * The suite stays green; the day the deep link is wired up, this test starts
 * running and it has to pass.
 *
 * THE DEEP LINK IS NOW WIRED. `PortfolioChat.tsx` reads the `q` parameter
 * inside a Suspense boundary, pre-fills the textarea and focuses it. This
 * test runs again, and it fails if that ever regresses.
 */
test("the 'Ask about this project' deep link pre-fills the composer", async ({
  page,
}) => {
  await page.goto("/projects/smartapply");

  await page.getByRole("link", { name: /How does SmartApply work\?/ }).click();

  // The question has to arrive in the query string ...
  //
  // The encoding of the spaces is not fixed: Next.js renders the link with
  // `%20`, and a hand-written link would use `+`. Both are the same
  // parameter, so the assertion accepts either.
  await expect(page).toHaveURL(
    /\?q=How(?:\+|%20)does(?:\+|%20)SmartApply(?:\+|%20)work%3F/,
  );

  // ... and pre-fill the composer on the home page.
  await expect(page.locator("#portfolio-composer")).toHaveValue(
    "How does SmartApply work?",
  );
});

test("/projects opens a project and the project links back", async ({ page }) => {
  await page.goto("/projects");

  await expect(
    page.getByRole("heading", { level: 1, name: /The work, audited/ }),
  ).toBeVisible();

  await page.getByRole("link", { name: /SmartApply/ }).first().click();

  await expect(page).toHaveURL(/\/projects\/smartapply$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "SmartApply" }),
  ).toBeVisible();

  await page.getByRole("link", { name: "All projects" }).click();

  await expect(page).toHaveURL(/\/projects$/);
  await expect(
    page.getByRole("heading", { level: 1, name: /The work, audited/ }),
  ).toBeVisible();
});
