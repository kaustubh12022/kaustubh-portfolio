import { expect, test } from "@playwright/test";

import {
  chatRequests,
  installChatMock,
  messageText,
  type MockVisualPayload,
} from "./helpers/chat-mock";

/**
 * The conversational flow.
 *
 * Four tests, all of them against a mocked `/api/chat` route, so the suite
 * costs $0.00 and gives the same result every time.
 */

const COMPOSER = "#portfolio-composer";

/** The visual a code question is answered with. */
const CODE_VISUAL: MockVisualPayload = {
  visual: {
    kind: "code",
    projectId: "smartapply",
    path: "src/ai_engine.py",
    startLine: 59,
    endLine: 61,
    code: [
      "def score_jobs(jobs):",
      "    costs = [cost_of(job) for job in jobs]",
      "    return rank(costs)",
    ].join("\n"),
    language: "python",
  },
  evidence: [
    {
      label: "src/ai_engine.py:59",
      projectId: "smartapply",
      path: "src/ai_engine.py",
      startLine: 59,
      endLine: 61,
      symbol: "score_jobs",
    },
  ],
  followUps: ["What does the scoring cost?"],
  confidence: "high",
  caveats: [],
  mode: "retrieval",
  droppedCitations: 0,
};

/** The visual a "what did you build" question is answered with. */
const PROJECT_VISUAL: MockVisualPayload = {
  visual: { kind: "project", projectId: "smartapply" },
  evidence: [],
  followUps: ["How does SmartApply work?"],
  confidence: "medium",
  caveats: [],
  mode: "retrieval",
  droppedCitations: 0,
};

test("the hero renders, the composer takes focus and the suggestion pills are visible", async ({
  page,
}) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { level: 1, name: /Kaustubh/ }),
  ).toBeVisible();

  const composer = page.locator(COMPOSER);
  await expect(composer).toBeVisible();

  // The composer has to be reachable by keyboard, not just by mouse.
  await composer.focus();
  await expect(composer).toBeFocused();

  await expect(
    page.getByRole("button", { name: /What did you build\?/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /How does SmartApply work\?/ }),
  ).toBeVisible();
});

test("a submitted question streams the answer and renders the visual card", async ({
  page,
}) => {
  await installChatMock(page, {
    // Two frames, so the first one is on screen while the second one is
    // still on the way. That is what "streamed" means.
    deltas: [
      "SmartApply filters the pool before any LLM call. ",
      "The token cost is paid once per real posting.",
    ],
    payload: PROJECT_VISUAL,
    delayMs: 250,
  });

  await page.goto("/");

  const composer = page.locator(COMPOSER);
  await composer.fill("How does SmartApply decide which postings to score?");
  await composer.press("Enter");

  // The FIRST frame is already rendered...
  await expect(
    page.getByText("SmartApply filters the pool before any LLM call."),
  ).toBeVisible();
  // ...and the whole answer arrives.
  await expect(
    page.getByText(/The token cost is paid once per real posting\./),
  ).toBeVisible();

  // The visual card is rendered from the `data-visual` part.
  await expect(
    page.getByRole("heading", { name: "SmartApply" }),
  ).toBeVisible();
});

test("a citation chip is shown and the code excerpt panel carries the line numbers", async ({
  page,
}) => {
  await installChatMock(page, {
    deltas: ["The cost is computed in `score_jobs`."],
    payload: CODE_VISUAL,
  });

  await page.goto("/");

  const composer = page.locator(COMPOSER);
  await composer.fill("Where is the scoring cost computed?");
  await composer.press("Enter");

  // The citation chip.
  const chip = page.getByText("src/ai_engine.py:59");
  await expect(chip).toBeVisible();

  // KNOWN GAP: the chip is a static <span> today (components/chat/Message.tsx
  // renders the evidence as labels), so clicking it does not toggle anything
  // - the code excerpt panel is already on screen. The click is kept here so
  // the day the chip becomes a button, this test starts asserting the
  // toggle instead of silently passing.
  await chip.click();

  // The code excerpt panel.
  await expect(page.getByRole("heading", { name: "Source" })).toBeVisible();
  await expect(page.getByText("src/ai_engine.py").first()).toBeVisible();
  await expect(page.getByText("L59–L61").first()).toBeVisible();

  // The gutter carries the line numbers of the cited range.
  const gutter = page.locator("pre code > span > span:first-child");
  await expect(gutter.first()).toHaveText("59");
  await expect(gutter.nth(1)).toHaveText("60");
  await expect(gutter.nth(2)).toHaveText("61");
});

test("a follow-up question keeps the conversation context", async ({ page }) => {
  await installChatMock(page, {
    deltas: ["SmartApply scores the postings it kept."],
    followUpDeltas: ["A cold answer costs about a cent per thousand postings."],
    payload: PROJECT_VISUAL,
  });

  await page.goto("/");

  const composer = page.locator(COMPOSER);
  await composer.fill("How does SmartApply score the postings?");
  await composer.press("Enter");

  // The answer is on screen, so the thread has replaced the hero.
  await expect(
    page.getByText("SmartApply scores the postings it kept."),
  ).toBeVisible();

  await composer.fill("And what does that cost?");
  await composer.press("Enter");

  // The follow-up produced its OWN answer, not a repeat of the first one.
  await expect(
    page.getByText("A cold answer costs about a cent per thousand postings."),
  ).toBeVisible();

  const requests = await chatRequests(page);
  expect(requests.length).toBe(2);

  const second = requests[1];
  // The first question, the answer to it, and the follow-up.
  expect(second.messages.length).toBe(3);
  expect(messageText(second.messages[0])).toBe(
    "How does SmartApply score the postings?",
  );
  expect(second.messages[1].role).toBe("assistant");
  expect(messageText(second.messages[2])).toBe("And what does that cost?");
});
