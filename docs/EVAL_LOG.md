# Evaluation log

**One row per evaluation run. If a run is not logged here, it did not happen.**

The rule comes from the cost policy: the spend is what has to be provable,
and a number nobody can reproduce is a number nobody should quote. Every row
below names the file that proves it.

The short version of the numbers on 2026-10-21:

| Layer | Result | Gate | Verdict |
|---|---|---|---|
| Retrieval (free, local embeddings) — **after Phase C** | recall@5 **51.3%**, file-level recall@5 **77.8%**, MRR@10 **40.0%** | 85% / 75% | **FAIL** |
| Retrieval (free, local embeddings) — before Phase C | recall@5 **34.8%**, MRR@10 **26.0%** | 85% / 75% | **FAIL** |
| Answers (150 questions, $0.153) | pass rate **53.3%** | 85% | **FAIL** |
| Answers (20 question slice, $0.023) | pass rate **65.0%** | 85% | **FAIL** |

The gates are RED. That is the honest state of the project on that date, and
the point of publishing the failing numbers is that the next person knows
exactly what is left to do.

**Phase C moved retrieval by +16.5pp chunk recall@5 and +13.2pp file-level
recall@5** (see `docs/RETRIEVAL.md` for every experiment). It did not close
the gap to 85%, and the answer benchmark has **not** been re-run since, so
53.3% is still the last measured answer pass rate.

---

## 1. The runs

### 1.1 The runs that cost money

| # | Date (UTC) | Commit | Run | Questions | Spend | Pass rate | Notes |
|---|---|---|---|---|---|---|---|
| 1 | 2026-10-21 12:48:09 | `561aa6b` | retrieval benchmark (`scripts/eval/retrieval-eval.ts`) | 150 selected, **79 scorable** | **$0.00** | recall@5 **34.8%**, MRR@10 **26.0%** | Local ONNX embeddings, no LLM at all. recall@10 44.9%, nDCG@10 38.3%, hit@10 57.0%. **File-level** recall@5 64.6%. Gates: recall@5 85%, MRR@10 75% → **FAIL**. Evidence: `evals/.retrieval-last.txt`, `docs/EVALUATION.md` §4. |
| 2 | 2026-10-21 12:52:15 | `561aa6b` | answer benchmark (`scripts/eval/golden-eval.ts`) | 150 | **$0.153169** | **53.3%** (80/150) | 60.0% ignoring the visual checks. $0.001021/answer, 1,306,368 cache-hit + 626,387 cache-miss + 92,154 completion tokens. p50 6,620 ms, p90 9,787 ms. 22 citations dropped by the validator. Evidence: `docs/EVALUATION.md` §6. |
| 3 | 2026-10-21 13:02:51 | `120e00c` | answer benchmark `--dry-run` | 20 | **$0.00** | not measured | A dry run: it prints what WOULD run and the cost estimate ($0.021600) and calls no model. Evidence: `evals/.golden-slice.txt`. |
| 4 | 2026-10-21 13:04:32 | `ddcd980` | answer benchmark, 20 question slice | 20 (q001–q008, q091–q102) | **$0.023111** | **65.0%** (13/20) | All 20 answers were cold (no cache hit): $0.001156/answer. code_explanation 5/8, claim_correction 8/12. Evidence: `evals/.golden-slice.json`, `evals/.last-run.json`. |
| 5 | 2026-10-21 17:10:23 | `64f8c07` | answer benchmark, **accidental** | 2 | **$0.002151** | 2/2 passed | **An accident, logged because it cost money.** While validating the promptfoo config, the two requests went to the live `/api/chat` route instead of the local stub: a dev server was already listening on `[::1]:3000` and `localhost` resolves to `::1` first on Windows. The stub had bound `127.0.0.1:3000`. Two real answers, $0.001045 + $0.001106. Evidence: `answer_log` rows at 17:10:23 UTC. The fix for the validation run was to point the stub at its own port (3999) instead of fighting for 3000. |

**Total LLM spend on 2026-10-21: $0.178431.** The plan's budget for the whole
remediation is $0.50, so $0.32 of it is still there.

### 1.2 The runs that cost nothing

These are the ones that should be run all the time.

| Date (UTC) | Run | What it proves | Spend |
|---|---|---|---|
| 2026-10-21 | `npm run typecheck` | `tsc --noEmit` is clean | $0.00 |
| 2026-10-21 | `npm run lint` | `eslint .` has no errors | $0.00 |
| 2026-10-21 | `npm test` | 195 unit + eval tests pass (12 files) | $0.00 |
| 2026-10-21 | `npx promptfoo validate config -c evals/promptfoo.yaml` | the promptfoo config loads | $0.00 |
| 2026-10-21 | `npx promptfoo eval -c evals/promptfoo.yaml` against a **local stub** on port 3999 | the assertions really execute: 15/13/14 assertions per case, the `javascript` checks pass, and the grounded check FAILS when the answer names a file it never cited | $0.00 |
| 2026-10-21 | `npx tsx scripts/eval/golden-eval.ts --url=http://127.0.0.1:3999/api/chat` against the same stub | the exit gate: **exit 1** below the gate, **exit 0** at or above it | $0.00 |
| 2026-10-21 | `npx playwright test` | 18 passed, 3 skipped, at 390 / 768 / 1440 px | $0.00 |
| 2026-10-22 | `npx tsx scripts/eval/bench.ts` — the Phase C tuning sweeps | every retrieval change measured one at a time: excluding test files (+9.5pp file-level recall@5), weighting the keyword leg 4x (+3.2pp chunk recall@5), and adding the local cross-encoder reranker (+13.2pp file-level recall@5). Two levers were measured and REJECTED: dropping high-document-frequency query tokens (−4.4pp) and IDF-weighting the substring leg (neutral). Evidence: `docs/RETRIEVAL.md` §3. | $0.00 |
| 2026-10-22 | `npx tsx scripts/eval/retrieval-eval.ts` — the authoritative re-measurement | recall@5 **51.3%**, recall@10 61.4%, MRR@10 **40.0%**, nDCG@10 59.0%, hit@10 72.2%, precision@10 13.2%, **file-level recall@5 77.8%**, file-level recall@10 84.2%. The `NO TESTS` diagnostics now match the baseline exactly, which is the proof that the test-file filter is live in the default configuration. | $0.00 |
| 2026-10-22 | `npm test` | 238 unit + eval tests pass (14 files) | $0.00 |
| 2026-10-22 | `node scripts/verify-deployment.mjs` | the deployment smoke test: 12 of 13 checks green against the live site. The one failure was the reranker layer, which the previous deployment did not have. Evidence: the script's own output. |
| 2026-10-22 | `node scripts/verify-deployment.mjs` — **after the redeploy** | **13 of 13 checks green** against the live deployment: the home page, all four retrieval layers (embedding, database, search, **reranker**), a streamed chat answer, `/mcp` refusing an unauthenticated request with 401, both project pages, and the three crawler files. | $0.00 |
| 2026-10-22 | answer benchmark, 20 question slice, **against the live deployment** | 55% overall, but **2 of the 20 questions were rate limited** (HTTP 429) and had no answer at all. The harness counted them as failures, which made it measure the rate limiter instead of the assistant. Fixed: a 429 is now reported as **skipped**, not failed, and the measured pass rate excludes it. Evidence: this run's `httpStatus` distribution, 18 × 200 and 2 × 429. | $0.018703 |
| 2026-10-22 | answer benchmark, 20 question slice, **against the local dev server** | **pass rate 65.0%** (13/20), **0 skipped**, $0.019546 ($0.000977/question). claim_correction **9/12 = 75%** (was 58.3% before Phase C), code_explanation 4/8 = 50%. Confidence: 15 high, 5 medium, 0 low. The four evidence failures were **all** "right file, wrong chunk" — zero wrong files. | $0.019546 |
| 2026-10-22 | the LangChain side-lab (`labs/langchain`) | the same retrieval task, the same weights, the same SQL, the same tuning and the same 79 questions, ported to Python: chunk recall@5 35.4% vs the shipped 51.3%, 5,815 ms per query vs ~2,700 ms. The cross-encoder was ruled out as the cause — the two ONNX runtimes produce byte-identical logits. Evidence: `docs/LANGCHAIN_COMPARISON.md`. | $0.00 |

**Total LLM spend on 2026-10-22: $0.038249.** Total across the whole
remediation, including the earlier day: **$0.21668** against the plan's
**$0.50** budget. $0.28 remains.

**Project to date**, from the `answer_log` table: **791 answers, $0.777879**
($0.000983 per answer). That figure includes the whole build - the 729
answers from before the remediation, the eval runs, and the manual testing.
The remediation session itself is the $0.21668 above.

The stub is a ~50 line HTTP server that answers `POST /api/chat` with the
same `data: {json}` frames the real route emits. It lives OUTSIDE the repo,
in the temporary directory, and it is what makes it possible to validate the
eval configuration without spending anything. See §4.

---

## 2. The gate

`scripts/eval/golden-eval.ts` used to end with an unconditional
`process.exit(0)`. A benchmark that can never fail is not a benchmark, so
the exit code is now the gate:

```
pass rate >= 85%  ->  exit 0
pass rate <  85%  ->  exit 1
```

The threshold is `DEFAULT_MIN_PASS_RATE = 0.85` and it can be moved for a
one-off run with the `GOLDEN_MIN_PASS_RATE` environment variable:

```bash
GOLDEN_MIN_PASS_RATE=0.5 npx tsx scripts/eval/golden-eval.ts
```

An unreadable or out-of-range value falls back to the published gate instead
of silently disabling the check.

**The gate is currently RED.** The measured rate is 65.0% on the 20 question
slice (measured against the local dev server, with the Phase C retrieval in
place), against a gate of 85%. The manual `golden-eval` workflow is
therefore expected to fail until the answer quality catches up with the
retrieval quality. That is the gate doing its job, not a broken pipeline.

**What the remaining failures actually are.** From the 2026-10-22 slice:

| check | failed / total | what it means |
|---|---|---|
| `evidence` | 4 / 8 | **every one of them "right file, wrong chunk"** — the retriever found the right file and the wrong part of it. Zero "wrong file". |
| `visualKind` | 3 / 12 | the model chose a `code` visual where the golden set expects a `claims` visual |
| `claim:smartapply-weasyprint` | 1 / 2 | the approved public wording was not reproduced verbatim |
| `claim:c54-socketio` | 1 / 1 | the approved public wording was not reproduced verbatim |
| `confidence` | 0 / 20 | every answer's confidence was internally consistent |
| `answerNotContains` | 0 / 20 | no forbidden claim leaked into an answer |

So the two remaining problems are **the chunk-level recall gap** (51.3% against
the file-level 77.8%) and **the model picking the wrong visual kind for a
claim-correction question**. Both are named, both are measurable, and neither
is a hallucination problem.

---

## 3. What each command costs

| Command | Spend | Needs |
|---|---|---|
| `npm run typecheck` | $0.00 | nothing |
| `npm run lint` | $0.00 | nothing |
| `npm test` | $0.00 | nothing (`tests/eval/golden-set.test.ts` SKIPS the live-index check when `DATABASE_URL` is missing) |
| `npm run test:e2e` | $0.00 | a dev server; the `/api/chat` route is mocked in the browser, so no model is called |
| `npm run eval` (promptfoo) | **$0.15** for the full 150 cases | a dev server and `DEEPSEEK_API_KEY` in the app's env |
| `npm run eval:answers` (golden-eval) | **$0.15** for the full 150 questions | a dev server and `DEEPSEEK_API_KEY` |
| `npx tsx scripts/eval/retrieval-eval.ts` | $0.00 | the local ONNX model and the database |

---

## 4. How to validate the eval configuration without spending money

The promptfoo config and the golden benchmark both talk to `POST /api/chat`.
To exercise them end to end for free, put a stub in front of the route:

```bash
# 1. the stub (in a TEMP directory, never in the repo)
node stub-chat.cjs        # listens on 127.0.0.1:3999 and answers with the
                           # same `data: {json}` frames the real route emits

# 2. point the config at the stub. Do NOT reuse port 3000: `localhost`
#    resolves to ::1 on Windows and a dev server may already own it.
#    Copy evals/promptfoo.yaml to a temp file and change the URL:
#      http://localhost:3000/api/chat  ->  http://127.0.0.1:3999/api/chat
npx promptfoo eval -c /tmp/promptfoo.stub.yaml --filter-first-n 3 --no-cache

# 3. the golden benchmark against the same stub
npx tsx scripts/eval/golden-eval.ts --url=http://127.0.0.1:3999/api/chat \
  --questions=q001,q002
```

This is how the assertion counts in §1.2 were obtained: 15, 13 and 14
assertions per case, with the two `javascript` checks first (they are the
`defaultTest.assert` block, which promptfoo prepends to every case).

---

## 5. Lighthouse

The budgets live in `.lighthouserc.json`:

| Budget | Value |
|---|---|
| performance | >= 0.95 |
| accessibility | 1.00 |
| cumulative layout shift | < 0.05 |

`lighthouse` and `lighthouse-ci` are deliberately NOT dependencies: they pull
a second Chrome download and a large dependency tree into a repository whose
entire point is that it is small and that every number is reproducible.

The lighter option, and the one to use:

```bash
# 1. the dev server has to be up
npm run dev

# 2. one run, mobile emulation, the two pages that matter
npx --yes lighthouse http://localhost:3000 \
  --quiet --output=json --output-path=./lighthouse-home.json \
  --chrome-flags="--headless=new --no-sandbox" \
  --only-categories=performance,accessibility,best-practices,seo

npx --yes lighthouse http://localhost:3000/projects/smartapply \
  --quiet --output=json --output-path=./lighthouse-smartapply.json \
  --chrome-flags="--headless=new --no-sandbox" \
  --only-categories=performance,accessibility,best-practices,seo

# 3. read the scores
node -e "for (const f of ['lighthouse-home.json','lighthouse-smartapply.json']) {
  const r = require('./' + f);
  console.log(f, 'performance', r.categories.performance.score,
    'accessibility', r.categories.accessibility.score,
    'CLS', r.audits['cumulative-layout-shift'].displayValue);
}"
```

`npx --yes lighthouse` downloads the tool into the npm cache instead of the
repository, so nothing is added to `package.json` and `npm ci` stays fast.

If the budgets ever have to be enforced automatically, `npx --yes @lhci/cli
autorun` reads `.lighthouserc.json` as it is written. That is a one-off
`npx` invocation too, so it still needs no dependency.

---

## 6. The accessibility gate

`tests/e2e/a11y.spec.ts` scans the home page with axe-core and fails on any
**serious** or **critical** violation. It is free and local: axe-core is
injected into the page.

One violation is known and still open, so it is listed in the test instead
of being hidden:

| Rule | Impact | Where |
|---|---|---|
| `label-content-name-mismatch` | serious | `components/chat/PortfolioChat.tsx:290-302` - the hero home button has `aria-label="Kaustubh Kale - home"` while its visible text is "KK Kaustubh Kale", so the visible text is not part of the accessible name |

The test PRINTS that violation on every run, so it cannot be forgotten, and
any NEW serious or critical violation still fails the suite.

---

## 7. What is not measured here

- **No run of the golden eval against the real model was performed for the
  Phase E changes.** The promptfoo and golden-eval configuration was
  validated against a local stub. The first real run after this change is
  the next row in this table.
- **The answer benchmark has not been re-run on the FULL 150 questions since
  the Phase C retrieval work landed.** The 53.3% figure is from
  2026-10-21 12:52 UTC against the OLD retriever. The 65.0% figure is the
  2026-10-22 20-question slice against the NEW retriever. The retrieval
  numbers in the summary table ARE current.
- **The E2E suite does not measure the model.** It mocks `/api/chat` on
  purpose, so it costs nothing and is deterministic. The model is measured
  by the answer benchmark, and only there.
- **The answer benchmark has to run against a LOCAL server to get a clean
  number.** The live deployment limits a client to 10 requests per 5 minutes,
  keyed on the real client IP, so a burst of 20 questions hits the limit.
  The harness sends a synthetic `x-forwarded-for` per request, which works
  locally (no proxy in the path) and does not work against Vercel (the edge
  prepends the real IP). A rate-limited question is reported as **skipped**,
  not as a failure, so the number measures the assistant and not the limiter.
