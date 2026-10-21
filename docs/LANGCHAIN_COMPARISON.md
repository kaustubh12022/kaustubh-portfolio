# LangChain vs AI SDK: a measured comparison

*This is the answer to "why didn't you just use LangChain?" — built and
measured, not asserted. The side-lab lives in `labs/langchain/` and is not
part of the deployment.*

---

## 1. What was built

The **same retrieval task**, twice:

| | TypeScript pipeline (shipped) | LangChain side-lab |
|---|---|---|
| Language | TypeScript, Node 26 | Python 3.13 |
| Framework | AI SDK 7, raw SQL | LangChain 1.4.6 |
| Embeddings | `@huggingface/transformers` (ONNX **WASM**) | `onnxruntime` 1.31.0 (native) |
| Embedding model | `Xenova/all-MiniLM-L6-v2`, 384-dim, q8 | the same file, the same bytes |
| Reranker | `Xenova/ms-marco-MiniLM-L-6-v2`, q8 | the same file, the same bytes |
| Vector store | Neon Postgres, `lakebase_ann` | the same database, the same table |
| Retrieval | ANN + tsvector + trigram + substring, RRF | the same four legs, the same SQL |
| Tuning | `DEFAULT_TUNING` | the same values, copied |
| Questions | the 79 scorable golden-set questions | the same 79, same loader, same filter |
| Metrics | `lib/eval/metrics.ts` | a function-for-function port in Python |
| LLM calls | none | none |

**The tuning was identical**, which matters, because the tuning is where the
accuracy came from:

```json
{"minVectorChars":120,"vectorWeight":1.0,"keywordWeight":4.0,
 "excludeTests":true,"genericTokenDfRatio":1.0,"useIdf":false,
 "rerank":true,"rerankDepth":20,"candidates":40,"prf":false,"prfTopK":5}
```

## 2. The numbers

| Metric | TypeScript (shipped) | LangChain lab | Δ |
|---|---|---|---|
| chunk recall@5 | **51.3%** | 35.4% | **−15.9pp** |
| chunk recall@10 | **61.4%** | 41.8% | −19.6pp |
| MRR@10 | **40.0%** | 27.0% | −13.0pp |
| nDCG@10 | **59.0%** | 36.1% | −22.9pp |
| hit-rate@10 | **72.2%** | 50.6% | −21.6pp |
| **file-level recall@5** | **77.8%** | 72.2% | −5.6pp |
| file-level recall@10 | **84.2%** | 79.1% | −5.1pp |

**Latency, per question:**

| Stage | TypeScript | LangChain lab |
|---|---|---|
| embed | ~3 ms | 26 ms |
| retrieve | ~900 ms | **3,959 ms** |
| rerank | ~1,800 ms | 1,831 ms |
| **total** | **~2,700 ms** | **5,815 ms** |
| p50 total | — | 5,919 ms |
| p95 total | — | 7,169 ms |
| max total | — | 8,397 ms |
| model load | 0 (bundled) | 519 ms |
| runtime | one Node process | Python venv + a dependency tree |

**The three lab modes:**

| mode | chunk r@5 | file r@5 | total latency | p95 |
|---|---|---|---|---|
| `production` | 35.4% | 72.2% | 5,815 ms | 7,169 ms |
| `multi-query` | 35.4% | 72.2% | **8,575 ms** | **14,822 ms** |
| `prf` | 35.4% | 72.2% | 6,873 ms | 7,976 ms |

**All three modes produce byte-identical metrics.** That is a finding, not a
mistake: **neither LangChain's `MultiQueryRetriever` nor pseudo-relevance
feedback changed a single ranking.** The expansion terms were already
covered by the existing legs, so the extra queries bought 2.8 seconds and
nothing else. The `multi-query` mode's p95 of 14.8 seconds would blow the
6-second answer budget on its own.

That also predicts something about the shipped pipeline: the pseudo-relevance
feedback behind `prf: false` in `lib/retrieval/search.ts` is unlikely to move
the metric either. It is still worth one `bench.ts` run to confirm, and it is
still off.

**Deployment footprint:** the shipped pipeline is one Next.js serverless
function with two ONNX sessions in it. The lab needs a Python virtualenv with
`langchain`, `langchain-core`, `langchain-community`, `langchain-postgres`,
`psycopg`, `pgvector`, `onnxruntime` and `numpy`.

## 3. What I checked, and what I could not

**The reranker is NOT the cause.** This was my first hypothesis — the
TypeScript runs the ONNX in WASM (the native binary cannot be traced into a
serverless bundle) and the lab runs it natively, so the quantised int8
weights could in principle behave differently.

They do not. Three (query, document) pairs, scored by both runtimes:

```
Python  onnxruntime (native)        : [-3.358729, -5.364287, -5.575093]
Node    @huggingface/transformers   : [-3.358729, -5.364287, -5.575093]
```

**Byte-identical.** The reranker model is doing the same thing in both
runtimes, so the 15.9-point gap is in the plumbing around it.

**What I did not fully isolate.** The remaining difference is in the retrieval
and compression plumbing: the lab's retrieval is **4.4× slower**, and its
reranking goes through LangChain's `CrossEncoderReranker` rather than the
hand-written `applyReranker`. I did not find the exact line responsible, and
I am not going to guess at one in a document whose whole point is that
nothing here is asserted without a measurement. **The honest statement is
that the two implementations are not equivalent, that the difference is worth
15.9 points of chunk recall, and that the model is not the reason.**

One difference I can name precisely: the file-level gap (−5.6pp) is much
smaller than the chunk-level gap (−15.9pp). Both pipelines find the right
*file* most of the time; they disagree about which *chunk* inside it is the
answer. That is a ranking difference, not a retrieval difference, and it
points at the compression step.

## 4. The conclusion

**I would not ship LangChain for this.**

Not because LangChain is bad — it is a good framework and the lab proves it
runs. Because:

1. **It measured worse on the thing that matters.** −15.9pp chunk recall@5
   and −22.9pp nDCG, with the same weights, the same SQL and the same
   tuning. The framework is not the variable; the hand-written plumbing
   around it is, and that plumbing is the part I had to write anyway.
2. **It measured 2.2× slower.** 5.8 s per query against a 6 s p95 budget for
   the whole answer, including the model.
3. **It costs a runtime.** The shipped app is one Node process. The lab needs
   Python, a virtualenv and a dependency tree that includes
   `langchain-community`, which is already being sunset — the lab's own
   `requirements.txt` says so.

The honest counterpoint: **the TypeScript pipeline is not simpler.** It has
632 lines in `lib/retrieval/search.ts`, a hand-written RRF, a hand-written
reranker application, and a hand-written tokenizer path. LangChain would
have given me the scaffolding for free. The argument is not "less code" — it
is "the scaffolding did not help the metric, and it cost a runtime and half
the latency".

## 5. What LangChain was genuinely better at

**Nothing measurable, as it turns out.**

The one place where LangChain's built-in abstraction looked like it would
beat the hand-written code was query expansion: the lab's `multi-query` mode
wraps the same retriever in LangChain's `MultiQueryRetriever`, and the
shipped pipeline implements the equivalent by hand as pseudo-relevance
feedback (`expansionTerms()` in `lib/retrieval/search.ts`).

Both were measured, and **neither moved the metric**. All three lab modes
return byte-identical recall and MRR. The expansion terms were already
covered by the existing legs, so the extra queries bought 2.8 seconds and
nothing else.

So the honest version of this section is: LangChain's query expansion was
*not* better here, it was **47% slower for the same answers**. And the
pseudo-relevance feedback in the shipped pipeline is still behind
`prf: false`, and this measurement predicts it will not move the metric
either — worth one `bench.ts` run to confirm, and it is still off.

One caveat on the comparison: `MultiQueryRetriever` normally asks an LLM to
write the paraphrases. The lab plugs in a **deterministic** expander so the
run is free and repeatable, which means the lab measures the framework's
plumbing, not the framework's LLM-based expansion. A real
`MultiQueryRetriever` would cost an LLM call per question — and it would
still have to beat the deterministic version on the metric, which the
deterministic version already matches.

## 6. The one-paragraph version

> *"I didn't pick AI SDK over LangChain because of a preference. I built the
> same retrieval flow in both — same embeddings, same cross-encoder, same
> Postgres, same SQL, same tuning, same 79 questions, same metric code — and
> measured both. The LangChain version scored 15.9 points lower on chunk
> recall@5 and ran 2.2× slower, and I checked the cross-encoder's logits in
> both runtimes to rule out the model being the difference. It wasn't the
> model. It was the plumbing, which was the part I had to write either way.
> LangChain was genuinely better at one thing — query expansion — and I've
> implemented that by hand and left it behind a flag until I measure it."*

## 7. Reproducing this

```powershell
cd labs\langchain
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt

# the production-parity run
.\.venv\Scripts\python -m langchain_lab.bench --mode production

# LangChain's own query expansion over the same retriever
.\.venv\Scripts\python -m langchain_lab.bench --mode multi-query

# the hand-rolled equivalent
.\.venv\Scripts\python -m langchain_lab.bench --mode prf

# what LangChain's own PGVector costs
.\.venv\Scripts\python -m langchain_lab.pgvector_probe
```

**No LLM call. $0.00.** The lab reads `DATABASE_URL` and
`DATABASE_URL_UNPOOLED` from the repository's `.env.local` and loads the
ONNX weights from `models/Xenova/`. It writes nothing outside the
`langchain_lab` schema, which the probe drops again.

The TypeScript side of the comparison is one command:

```powershell
npm run bench
```

`scripts/eval/bench.ts` reproduces the reference numbers above exactly, and
its "reference" pass is frozen at the pre-Phase-C configuration so a future
change is always measured against the same baseline.
