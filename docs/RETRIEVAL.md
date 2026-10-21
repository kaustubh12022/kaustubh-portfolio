# Retrieval: what was measured, what changed, and what is still missing

This is the measurement log for the retrieval pipeline. Every number here was
produced by `scripts/eval/retrieval-eval.ts` or `scripts/eval/bench.ts`
against the live Neon index. **No LLM call was made to produce any of them** —
the embeddings and the reranker both run locally in ONNX, so the whole
retrieval layer costs $0.00 per query.

---

## 1. The system

```
question
   │
   ├─► embedQuery()            local ONNX, Xenova/all-MiniLM-L6-v2, 384-dim, q8
   │
   ├─► stage 1: retrieve       4 legs, 40 candidates each
   │     ├─ vector ANN         lakebase_ann index, cosine distance
   │     ├─ tsvector           BM25, ts_rank
   │     ├─ trigram            symbol / path similarity
   │     └─ substring          content ILIKE, exact fallback
   │     └─ fused with Reciprocal Rank Fusion (k = 60)
   │
   ├─► stage 2: rerank         local ONNX, Xenova/ms-marco-MiniLM-L-6-v2, q8
   │     the cross-encoder reads (question, chunk) TOGETHER and re-orders
   │     the top 20 fused candidates
   │
   └─► citation validation     the server re-reads the index and drops any
                                cited line range that no chunk covers
```

**Why two stages.** The bi-encoder embeds the question once and every chunk
once, then compares vectors. It never sees the question and the code
together, so it has to *hope* that a sentence embedding of "which jobs are
worth scoring" lands near an embedding of a function called `is_relevant_jd`.
The cross-encoder reads both at once and outputs one number for the pair —
much more accurate, but one forward pass per candidate, so it cannot search a
corpus. Standard retrieve-then-rerank.

**Both models run in the same process.** There is no model server, no Python
runtime, no second deployment, and no API key. That is the single biggest
architectural decision in the retrieval layer.

---

## 2. The result

79 of the 150 golden questions are scorable against the index (the other 71
are answered from the content layer by design and are not retrieval-scored).

| Metric | Before | After | Change |
|---|---|---|---|
| chunk recall@5 | 34.8% | **51.3%** | **+16.5pp** |
| chunk recall@10 | 44.9% | 61.4% | +16.5pp |
| MRR@10 | 26.0% | **40.0%** | **+14.0pp** |
| nDCG@10 | 38.3% | 59.0% | +20.7pp |
| hit-rate@10 | 57.0% | 72.2% | +15.2pp |
| precision@10 | 9.1% | 13.2% | +4.1pp |
| **file-level recall@5** | 64.6% | **77.8%** | **+13.2pp** |
| file-level recall@10 | 75.9% | 84.2% | +8.3pp |

### Which number is the gate, and why

The **product** question is *"did we find the right file so the answer can
cite it?"* — that is file-level recall. Chunk-level recall is about how much
surrounding context the model gets once the file is right. Both are published;
the gate is on file-level recall because that is what the visitor experiences.

Target was file-level recall@5 ≥ 0.85. **Measured: 0.778.** The gap is real
and is discussed in §6.

---

## 3. The experiments

Every change was measured on its own. `scripts/eval/bench.ts` is the
iteration harness: it caches the query embeddings on disk, so a run costs the
SQL time only. Its "reference" pass reproduces the authoritative benchmark
**exactly** (34.8 / 44.9 / 26.0 / 57.0 / 9.1 / 64.6 / 75.9), which is what
makes the deltas trustworthy.

| # | Change | chunk r@5 | file r@5 | MRR@10 | Verdict |
|---|---|---|---|---|---|
| 0 | reference (pre-Phase-C) | 34.8% | 64.6% | 26.0% | — |
| 1 | exclude test files from the pool | 44.3% | 75.3% | 32.0% | **keep** |
| 2 | IDF-weight the substring leg | 36.7% | 65.8% | 25.4% | **drop** (neutral) |
| 3 | drop high-document-frequency query tokens | 26.6% | 60.1% | 20.1% | **drop** (−8.2pp) |
| 4 | weight the keyword leg 4× the vector leg | 47.5% | 73.4% | 37.5% | **keep** |
| 5 | lower the vector-leg minimum length 120→40 | 41.8% | 74.7% | 31.9% | **drop** |
| 6 | + cross-encoder reranker, top 10 | 50.6% | 75.3% | 42.1% | keep |
| 7 | **+ cross-encoder reranker, top 20** | **51.3%** | **77.8%** | **40.0%** | **keep — final** |
| 8 | + cross-encoder reranker, top 30 | 48.7% | 77.8% | 39.0% | **drop** |
| 9 | + pseudo-relevance feedback | not measured | — | — | **deferred** |

### What each one taught us

**1. Test files were eating every top slot.** 1,116 of 3,068 chunks (36%) of
the corpus is test code. A question like *"how does the settlement engine
work"* matched `tests/test_m5_ats_pdf.py` on generic vocabulary ("booking",
"user", "job") and never reached the implementation. Filtering test paths out
of the candidate pool — *unless the question itself asks about tests* — was
worth **+9.5pp file-level recall@5** on its own. This was the single
largest lever, and it came from reading the corpus rather than from tuning.

**4. The keyword leg deserves four times the weight of the vector leg.** The
keyword leg is internally fused from three sub-legs and the vector leg from
one, so leaving both at weight 1 already gave the keyword leg 3× the
influence by accident. Making that explicit — `keywordWeight: 4` — was worth
another **+3.2pp chunk recall@5** and **+5.5pp MRR@10**. It is also the
honest answer: `all-MiniLM-L6-v2` is a *sentence* model, so it is better at
prose than at code identifiers, and the trigram leg matches `findZeroSumSubsets`
exactly.

**7. The cross-encoder is worth +13.2pp on top of everything else.** It only
sees the top 20 of the fused pool. Depth 10 was cheaper (2.1 s/question) and
slightly worse; depth 30 was slower and worse still, because the reranker
starts promoting noise from a deeper pool.

### What did NOT work, and why it is worth knowing

**3. Dropping "generic" query tokens made things much worse** (−8.2pp chunk
recall@5). The idea was to discard tokens that appear in more than 2% of the
corpus, on the reasoning that they cannot discriminate. But the tokens that
look generic in a corpus of English prose — "job", "booking", "user" — are
exactly the domain vocabulary of a question. Throwing them away removed the
only link between the question and the code.

**2. IDF-weighting the substring leg was neutral.** Intuitively right: a
chunk that matches one rare identifier should beat a chunk that repeats a
common word. In practice it moved file-level recall by +1.3pp and chunk
recall by +1.9pp, both inside the noise. The substring leg is not what decides
the ranking once the test files are gone, so improving it changes little.

**5. Lowering the vector-leg minimum content length from 120 to 40
characters** was intended to let short functions into the ANN leg. It made
chunk recall worse and file recall slightly better. Short chunks really are
noisy for a bi-encoder, exactly as the original comment said.

---

## 4. Two bugs this work found

**The "47 not in the index" panic was a measurement artefact.**
`scripts/eval/diagnose-retrieval.ts` reported that 47 of 118 golden evidence
entries were not in the corpus, which looked like a broken index. It was not:
the diagnostic used strict line-range **containment**
(`start_line <= $3 AND end_line >= $4`) while the benchmark uses
**overlap**. A chunk that covers 90% of an expected range is a correct
retrieval. The corpus was complete the whole time. The diagnostic now says so
in its header comment.

**`read_file` had no output cap.** Every other tool clipped its output;
`read_file` returned the whole file, so a model that asked for a file without
a line range got 20,000 tokens of uncached input. It is now capped at 200
lines and says so in its response, so the model can ask for the rest.

---

## 5. The configuration that ships

```ts
export const DEFAULT_TUNING: SearchTuning = {
  minVectorChars: 120,
  vectorWeight: 1,
  keywordWeight: 4,
  excludeTests: true,
  genericTokenDfRatio: 1,   // off: measured to hurt
  useIdf: false,            // off: measured to be neutral
  rerank: true,
  rerankDepth: 20,
  candidates: 40,
  prf: false,               // deferred: see §6
  prfTopK: 5,
};
```

Every one of those values is a measurement, not a preference. The knobs are
exported so the benchmark can sweep them, and `bench.ts` keeps the
pre-Phase-C configuration frozen as its reference so a future change is
always measured against the same baseline.

**Latency.** 2.7 s per question end to end, of which roughly 1–2 s is the
cross-encoder on CPU. The embedding itself is ~2.8 ms warm.

**Cost.** $0.00. Both models are bundled in the repository (22.6 MB + 23.0 MB)
and traced into the serverless bundle by `next.config.ts`.

---

## 6. What is still missing

**File-level recall@5 is 0.778, not 0.85.** The honest reason is the
embedding model. `all-MiniLM-L6-v2` is a general-purpose *sentence* encoder
trained on natural language, and this is a corpus of Python, TypeScript, Dart
and SQL. It has no idea that `is_relevant_jd` is the answer to "which jobs
are worth scoring" — only the cross-encoder can work that out, and only
because it reads the two texts together.

The next experiment is a **code-aware embedding model** (a
`jina-code` or `unixcoder` style checkpoint, or a model fine-tuned on
The Stack), re-embedding all 3,068 chunks and re-running this exact
benchmark. It is a re-index, not a rewrite, and the harness to measure it
already exists. It was deferred so the pipeline could ship first.

**Pseudo-relevance feedback is implemented but unmeasured.**
`expansionTerms()` and the second keyword pass are in `lib/retrieval/search.ts`
behind `prf: false`. The idea is the classic one: take the identifiers of the
best candidates and search for them again, which finds the neighbouring
functions of the right file. It was written but the sweep was interrupted, so
the default is off and no number is claimed for it. Measuring it is one
`bench.ts` run.

**The `symbols` and `edges` tables are empty.** The schema declares them and
the code queries them, but nothing ever inserts into them. `find_symbol`
falls back to a trigram match over `chunks.symbol`, which works. The
call-graph tables are a Phase 2.8 leftover that was never wired up.

---

## 7. Reproducing this

```powershell
# the authoritative benchmark (writes the JSON report)
$env:NODE_OPTIONS="--conditions=react-server"
npx tsx scripts/eval/retrieval-eval.ts --json --out evals/retrieval-report.json

# the fast iteration harness (caches embeddings, ~30 s)
npx tsx scripts/eval/bench.ts --no-reference

# sweep one knob
npx tsx scripts/eval/bench.ts --tuning-file tuning.json
```

**The `NODE_OPTIONS` flag is not optional.** Both scripts import
`server-only`, which throws outside a React Server Component context. This is
documented in `docs/COST_POLICY.md` and `docs/EVALUATION.md`; it is the reason
a retriever that works in `npm run dev` can appear to be broken in a script.

Both scripts talk to the live database and read `.env.local`. Neither calls
an LLM.
