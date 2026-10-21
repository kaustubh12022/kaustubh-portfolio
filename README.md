# Kaustubh Kale — conversational portfolio

**Live:** <https://kaustubh-portfolio-navy.vercel.app>

This is not a portfolio that lists projects. It is a retrieval system over my
own source code that answers questions about it — and says so when the
evidence is not there. Ask *"How does SmartApply decide which postings are
worth sending to the model?"* and the answer carries the exact file, the
exact line range and the exact function, because the assistant is not allowed
to cite a range that does not exist: after the model answers, a **citation
validator re-reads the index** and drops every citation it cannot resolve,
downgrades the confidence and tells the visitor how many were dropped.

It exists because a portfolio full of claims is worth nothing to a reviewer
who cannot check them. Every number in this repository has a method and a
source next to it, and the whole system is measured rather than asserted —
including the parts that do not work yet, which are listed at the bottom of
this file.

---

## Architecture

```
  browser
    │  POST /api/chat   { messages: [...] }
    ▼
  app/api/chat/route.ts
    │
    │  1. rate limit        in-process, 10 requests / 5 min per client key
    │  2. answer cache      in-memory, 24 h TTL, dropped when the index is re-indexed
    │  3. spend ceiling     per instance per day; over it the answer comes from the content layer
    │
    │  4. DeepSeek agent    streamText, 12 read-only tools, at most 4 steps
    │        │
    │        │  5. hybrid retrieval ──► Neon / Postgres
    │        │       vector leg     ANN over lakebase_ann, 384-dim, local ONNX   $0.00
    │        │       keyword leg    tsvector  +  trigram  +  substring
    │        │       fusion         reciprocal rank fusion, k = 60
    │        │
    │        │  6. rerank         local cross-encoder, re-orders the top 20 fused  $0.00
    │        │                     candidates (it reads the question and the code together)
    │        │
    │        │  7. citation validator   re-reads the index; unverifiable ranges are dropped
    │        ▼
    │  8. SSE stream         text deltas + one `data-visual` frame
    ▼
  browser ──► components/chat/Message.tsx ──► VisualRenderer (12 visual kinds)

  also served:  POST /mcp   (10 read-only tools over the same index, bearer auth)
                GET  /api/health   (names the failing layer: embedding, database, search)
```

Everything on this path is either local or a single Postgres database. There
is no hosted vector database, no second model provider and no external
embedding API.

---

## What is measured

| | |
|---|---|
| **Corpus** | **3,068 chunks from 6 repositories**, chunked by tree-sitter (AST, not line windows), each chunk carrying a contextual header with repo, file, symbol and imports |
| **Embeddings** | `Xenova/all-MiniLM-L6-v2`, 384-dim, running locally in ONNX — **$0.00 per query** |
| **Reranker** | `Xenova/ms-marco-MiniLM-L-6-v2` (23 MB), a local cross-encoder — **$0.00 per query** |
| **Retrieval** | hybrid: ANN vector + `tsvector` full-text + trigram + substring, fused with **reciprocal rank fusion**, then re-ordered by the cross-encoder |
| **Evaluation set** | a **150-question golden set** in `evals/golden-set.yaml`, with the expected file, line range and symbol for every code question |
| **Citations** | a validator that **re-reads the index** after the model answers and drops line ranges that do not resolve |

The embeddings and the reranker are why the retrieval work costs nothing to
measure: `npm run bench` and `npm run eval:retrieval` run the whole golden
set against the live index for **$0.00**, because no model is ever called.

---

## Measured results

Retrieval, measured with `scripts/eval/retrieval-eval.ts` against the live
index on the 150-question golden set (79 questions are scorable against the
code index; the other 71 are answered from the content layer).

| Metric | Before | After | Gate |
|---|---|---|---|
| chunk recall@5 | 34.8% | **51.3%** | 85% (chunk-level is published as context precision) |
| file-level recall@5 | 64.6% | **77.8%** | 85% — **this is the product gate** |
| MRR@10 | 26.0% | **40.0%** | 75% |

What changed between the two measurements: test files were dropped from the
candidate pool unless the question is about tests (**+9.5pp** file-level
recall@5 on its own — 36% of the corpus is test code and it was eating every
top slot), the keyword legs (`tsvector` + trigram + substring) are weighted
4× against the sentence embedding (**+3.2pp** chunk recall@5), and a local
cross-encoder re-orders the top 20 fused candidates (**+13.2pp** file-level
recall@5 on top of everything else). Two other levers were measured and
**rejected**: IDF-weighting the substring leg (neutral) and lowering the
vector-leg minimum length from 120 to 40 characters (worse). Every one of
those was a separate measurement; the log is in
[`docs/RETRIEVAL.md`](docs/RETRIEVAL.md).

The "before" column and its diagnostics are in
[`docs/RETRIEVAL_BASELINE.md`](docs/RETRIEVAL_BASELINE.md); the full
measurement log is in [`docs/RETRIEVAL.md`](docs/RETRIEVAL.md).

---

## The truth rules

1. Source code at a pinned commit is the highest authority.
2. The resume is a claim, not evidence.
3. Every public metric has a method and a source.
4. Contradicted claims are answered explicitly, not hidden.
5. No fabricated screenshots, metrics, companies, or skills.

They are enforced, not just written down: the claim ledger in
`content/claims.yaml` records what the old resume said against what the code
supports, the citation validator drops unverifiable ranges at runtime, and
`tests/eval/evidence-paths.test.ts` fails the build if a content file cites a
path that is not in the index.

---

## Quick start

```powershell
git clone https://github.com/kaustubh12022/kaustubh-portfolio.git
cd kaustubh-portfolio
npm install
copy .env.example .env.local     # then fill in the values below
npm run dev
```

Open <http://localhost:3000>.

Two ONNX models are **committed to the repository** (`models/Xenova/…`, 45.6 MB
in total) so a cold start never depends on reaching the Hugging Face CDN.

The app runs without any credentials — it falls back to the curated offline
answers and says so. To get the live agent, fill in `DEEPSEEK_API_KEY`,
`DATABASE_URL` and `DATABASE_URL_UNPOOLED` in `.env.local`.

---

## Commands

| Command | Purpose | Cost |
|---|---|---|
| `npm run dev` | Next.js dev server | — |
| `npm run build` | production build | — |
| `npm run typecheck` | `tsc --noEmit` | $0.00 |
| `npm run lint` | ESLint | $0.00 |
| `npm test` | Vitest unit + eval suites | $0.00 |
| `npm run test:e2e` | Playwright, 3 viewports, `/api/chat` mocked | $0.00 |
| `npm run bench` | the fast retrieval benchmark — reference config vs the production config, side by side | $0.00 |
| `npm run eval:retrieval` | the authoritative retrieval benchmark against the live index | $0.00 |
| `npm run eval` | promptfoo over the golden set (150 cases) | **model calls** |
| `npm run index` | rebuild the code index from the local clones | $0.00 |

Also available: `npm run index:dry` (scan without writing), `npm run
eval:answers` (the answer benchmark, **model calls**), `npm run eval:cases`
(regenerate the promptfoo cases).

`bench` and `eval:retrieval` reach the retrieval layer, which imports
`server-only`, so they need the `react-server` export condition. The npm
scripts pass `--conditions=react-server` to `tsx` themselves, which works on
Windows, macOS and Linux without an extra dependency. If you run the scripts
directly instead, set it yourself:

```powershell
$env:NODE_OPTIONS="--conditions=react-server"; npx tsx scripts/eval/bench.ts
```

---

## Environment

`.env.example` is the full list. In short:

| Variable | Required | What it does |
|---|---|---|
| `DEEPSEEK_API_KEY` | for the live agent | the model provider. The assistant is DeepSeek-only. |
| `DATABASE_URL` | for retrieval | the **pooled** Neon connection string. |
| `DATABASE_URL_UNPOOLED` | for retrieval | the **direct** connection string. Required for the ANN leg: the pooler cannot serve `lakebase_ann`. |
| `MCP_AUTH_TOKEN` | in production | bearer token for `POST /mcp`. Without it `/mcp` is open. |
| `KAUSTUBH_REPOS_ROOT` | for `npm run index` | where the source repositories live on disk. Defaults to `~/Desktop/GitHub projects`. |
| `NEXT_PUBLIC_SITE_URL` | in production | the public origin. A missing value falls back to `http://localhost:3000`, and that fallback is baked into the build: every canonical URL, every Open Graph tag and every sitemap entry would point at localhost. |
| `DAILY_SPEND_CEILING_USD` | optional | the daily model budget. At the ceiling the assistant answers from the content layer instead of calling the model. |

Rate limiting is **in-process and per-instance**, and the spend ceiling is
**per-instance per day**. Neither is a global quota.

---

## Project structure

```
app/                  Next.js app router: home, /projects/[slug], /api/chat, /api/health, /mcp
components/chat/      chat shell, composer, messages, citation chips, visual renderer
components/visuals/   the 12 visual components (code explorer, architecture, metrics, claims, ...)
content/              profile, projects, claims, metrics, assets, architecture, data models
lib/content/          Zod schemas + YAML loader
lib/retrieval/        embedding, hybrid search, RRF fusion, local reranker, Postgres access
lib/ai/               the agent, the 12 tools, the citation validator, cache, rate limit, spend
lib/mcp/              the MCP server (10 tools, resources, prompt)
lib/eval/             the golden set and the metric functions (pure, no I/O)
scripts/index/        tree-sitter chunking, secret scan, PII gate, the index writer
scripts/eval/         the benchmarks and the evaluation CLIs
evals/                the 150-question golden set and the promptfoo config
docs/                 the measurements, the security write-up, the MCP guide
models/               the two committed ONNX models
```

---

## Known limitations

This is the part worth reading. Every item below is true today.

1. **File-level recall@5 is 77.8%, not 85%.** The retrieval gate is not
   met. Chunk-level recall@5 is 51.3% against an 85% target, and MRR@10 is
   40.0% against 75%. The product question is *"did we find the right file so
   the answer can cite it?"*, which is why file-level recall is the gate and
   chunk-level recall is published as a context-precision metric — but the
   gate is still red, and it is red in the table above rather than hidden in
   a footnote.
2. **The embedding model is a general-purpose sentence model**, not a
   code-aware one. `all-MiniLM-L6-v2` was trained on natural language, so
   "how does it decide which jobs are worth scoring" has to land near
   `is_relevant_jd` by luck. That is why the keyword legs are weighted
   higher than the vector leg, and why the cross-encoder — which reads the
   question and the code together — is the stage that does the real work.
3. **The rate limiter is in-process and per-instance.** It is a map in the
   memory of one serverless instance, so it slows down one noisy client; it
   does not enforce a global quota across instances.
4. **The spend ceiling is per-instance per day.** Two instances can each
   spend the ceiling. A real deployment needs a shared counter.
5. **`/mcp` needs `MCP_AUTH_TOKEN` set or it is open.** The endpoint serves
   the line-exact source of every indexed repository. The route logs an
   error on every request while the token is unset, but a log line is not a
   control.
6. **The answer benchmark is below its gate.** The full 150-question answer
   run scored **53.3%** against an 85% gate (the 20-question slice scored
   65.0%). The benchmark now exits non-zero below the gate, so the gate is
   real, and it is currently red. The retrieval work is the dependency, not
   an excuse.
7. **One diagnostic in the repo still lies.** `scripts/eval/diagnose-retrieval.ts`
   reports "not in the index at all" using strict containment while the
   benchmark uses overlap, so its count is far too high. The file says so at
   the top now; the corpus was never the problem.

---

## Key docs

- [`docs/HOW-IT-WAS-BUILT.md`](docs/HOW-IT-WAS-BUILT.md) — the post-mortem: what I found in my own history, why the claim ledger came first, and how the retrieval system was put together.
- [`docs/RETRIEVAL.md`](docs/RETRIEVAL.md) — the retrieval measurement log: every tuning step, before and after.
- [`docs/RETRIEVAL_BASELINE.md`](docs/RETRIEVAL_BASELINE.md) — the pre-optimisation baseline and its diagnostics.
- [`docs/EVALUATION.md`](docs/EVALUATION.md) — the evaluation design, the metric definitions and the answer results.
- [`docs/EVAL_LOG.md`](docs/EVAL_LOG.md) — one row per evaluation run: date, commit, spend, pass rate. *If a run is not logged, it did not happen.*
- [`docs/MCP.md`](docs/MCP.md) — the MCP server, its tools and how to deploy it.
- [`docs/SECURITY.md`](docs/SECURITY.md) — the secret history, the PII regex false negative, the allowlist and the secret gate.
- [`docs/COST_POLICY.md`](docs/COST_POLICY.md) — what each command costs and why no LLM call is used to test code.
- [`docs/RESUME_CORRECTIONS.md`](docs/RESUME_CORRECTIONS.md) — the exact old → new resume bullets.
- [`docs/ASSET_CAPTURE.md`](docs/ASSET_CAPTURE.md) — how the project screenshots were captured.
- [`content/claims.yaml`](content/claims.yaml) — the claim ledger the assistant answers from.
