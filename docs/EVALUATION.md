# Evaluation

How good is the conversational portfolio, really? This document is the
measurement, not the intention.

Everything below was measured on **21 October 2026** against the live Neon
index and the live `/api/chat` route. The numbers are the output of the two
scripts in `scripts/eval/`, and every command needed to reproduce them is
written down.

---

## 1. What is measured, and with what

There are three layers, and they are deliberately separated because they fail
for different reasons.

| Layer | Script | Model called? | What it answers |
|---|---|---|---|
| **Retrieval** | `scripts/eval/retrieval-eval.ts` | no (embedding only) | Does the hybrid retriever put the right source chunk in the top k? |
| **Answer** | `scripts/eval/golden-eval.ts` | yes (150 LLM calls) | Does the whole pipeline answer correctly, cite correctly and refuse correctly? |
| **Asset** | `tests/eval/golden-set.test.ts`, `tests/eval/metrics.test.ts` | no | Is the golden set itself still valid, and are the metric functions correct? |

The golden set lives in `evals/golden-set.yaml`: **150 questions** in nine
buckets.

| Bucket | n | What it is about |
|---|---|---|
| `code_explanation` | 30 | "How does X work?" - the answer has to name the mechanism and cite the code |
| `file_lookup` | 20 | "Which file/function does X?" - the answer has to name a path and a symbol |
| `architecture` | 15 | "How is X put together?" |
| `data_model` | 10 | "What does the schema look like?" |
| `metrics` | 15 | "What numbers can you prove?" - answered from `content/metrics.yaml` |
| `claim_correction` | 25 | "Your resume says X. Prove it." - the answer has to contradict the claim and reproduce the approved public wording |
| `comparison` | 10 | "How do X and Y differ?" |
| `off_topic_refusal` | 15 | "What is the weather?" - the answer has to refuse |
| `adversarial_prompt_injection` | 10 | injection attempts that try to make the assistant confirm a contradicted capability or leak the system prompt |

The 25 `claim_correction` questions cover every claim the brief calls out:
`java-spring`, `medflow`, `c54-socketio`, `smartapply-weasyprint`,
`pawna-name` (the CampFlow naming), `campflow-owners`,
`campflow-multitenant`, `campflow-microservices`, `personal-ai-os-stack`,
`rag-vector` and `neon-pulse`. `tests/eval/golden-set.test.ts` asserts that
each of them is exercised.

---

## 2. The metric definitions

`lib/eval/metrics.ts` is a pure module: no database, no embeddings, no I/O.
`tests/eval/metrics.test.ts` checks it against hand-computed numbers.

**Relevance.** A retrieved chunk satisfies an expectation when it is the same
file **and** its line range overlaps the expected range. Overlap, not
equality: the indexer chunks by AST, so a chunk is usually a superset of the
function body. When an expectation names a symbol but no line range, the hit
has to be in the same file and carry the same symbol.

**The expected range is the WHOLE function.** The chunker splits a long
function across several chunks: `handleGeminiLiveRelay` is eight chunks
covering lines 64-631, `score_jobs` is four chunks covering 333-586. The
relevant passage for "where is X implemented" is the whole function, so
`scripts/eval/fix-golden-ranges.ts` rewrites every expected range to the union
of that symbol's chunks, straight out of the live index. Without this the
measurement is wrong by construction: every other chunk of the same function
would count as a miss. The fix moved overall recall@5 from 27.8% to 34.8%.

| Metric | Definition |
|---|---|
| `recall@k` | fraction of the expected ranges that were retrieved in the top k |
| `hitRate@k` | 1 when at least one expected range was retrieved in the top k, else 0 |
| `precision@k` | fraction of the top k that was relevant |
| `MRR@k` | `1 / rank` of the first relevant hit, 0 when there is none |
| `nDCG@k` | `DCG@k / IDCG@k`, gain is binary, discount is `1/log2(rank+1)` |

**What a question counts against.** The 79 questions that name source files are
scored by the retrieval benchmark. The other 71 (metrics, claims, comparisons,
refusals) are answered from the content layer and the claim ledger; they have
no code target, so they are excluded from the retrieval numbers and scored by
the answer benchmark instead.

---

## 3. How to run it

```bash
# the dev server has to be up for the answer benchmark
npm run dev

# 3. the retrieval benchmark (no LLM, no cost)
#    `lib/retrieval/db.ts` carries `import "server-only"`, so the CLI runs with
#    the react-server condition
NODE_OPTIONS=--conditions=react-server npx tsx scripts/eval/retrieval-eval.ts
NODE_OPTIONS=--conditions=react-server npx tsx scripts/eval/retrieval-eval.ts --questions=q001,q002
NODE_OPTIONS=--conditions=react-server npx tsx scripts/eval/retrieval-eval.ts --json --out=report.json

# 4. the answer benchmark (150 LLM calls, about $0.15)
npx tsx scripts/eval/golden-eval.ts
npx tsx scripts/eval/golden-eval.ts --bucket=claim_correction --per-bucket=10
npx tsx scripts/eval/golden-eval.ts --questions=q091,q095 --json --out=report.json

# 5. promptfoo (needs a grader key)
npx promptfoo eval -c evals/promptfoo.yaml

# 7. the fast, LLM-free tests
npx vitest run
```

The answer benchmark sends a different `x-forwarded-for` per request. The route
rate limits to 10 requests per 5 minutes per IP (`lib/ai/ratelimit.ts`), which
is explicitly documented as a courtesy limit, not a security boundary. This
only applies to the local benchmark against the local dev server.

---

## 4. Retrieval results

**Thresholds: recall@5 >= 0.85, MRR@10 >= 0.75.**

<!--RETRIEVAL-RESULTS-->

---

## 5. Answer results

150 questions against the live `/api/chat` route over HTTP.

<!--ANSWER-RESULTS-->

---

## 6. What is broken, in order of cost

<!--FINDINGS-->

---

## 7. The next improvement

<!--NEXT-STEPS-->
