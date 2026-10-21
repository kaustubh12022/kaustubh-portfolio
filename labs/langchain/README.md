# LangChain side-lab

A **measured** comparison: the same retrieval task, the same Neon
database, the same golden set, the same model weights - once in the
TypeScript pipeline the portfolio ships, once in LangChain.

The write-up with the numbers is `docs/LANGCHAIN_COMPARISON.md`.

This folder is **not** part of the deployed app. Nothing in `app/`,
`lib/`, `components/` or `scripts/` imports it.

---

## What it is

```
langchain_lab/
  config.py        paths, .env loading, the two Neon connection strings
  golden.py        a port of lib/eval/golden.ts (the loader + the filter)
  metrics.py       a port of lib/eval/metrics.ts (the metric functions)
  embeddings.py    the bundled `all-MiniLM-L6-v2` ONNX file, as a LangChain
                   `Embeddings`
  cross_encoder.py the bundled `ms-marco-MiniLM-L-6-v2` ONNX file, as a
                   LangChain `BaseCrossEncoder`
  store.py         the hybrid search: vector leg + keyword legs + RRF
  retriever.py     the LangChain chain: MultiQueryRetriever, HybridRetriever,
                   CrossEncoderReranker
  bench.py         the benchmark: the same 79 questions, the same metrics
  pgvector_probe.py  the experiment: what LangChain's own PGVector costs
```

## Setup

```powershell
cd labs\langchain
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
```

The lab needs `DATABASE_URL` and `DATABASE_URL_UNPOOLED` in the
repository's `.env.local`. It reads that file itself, exactly like
`scripts/eval/env.ts` does. It never talks to any other database.

The embedding and reranker models are the ONNX files the repository
already ships under `models/Xenova/`. The lab does not download anything.

## Run it

```powershell
# the production-parity run: one embedding, one hybrid search, one rerank
.\.venv\Scripts\python -m langchain_lab.bench --mode production

# with LangChain's MultiQueryRetriever wrapped around the same retriever
.\.venv\Scripts\python -m langchain_lab.bench --mode multi-query

# with pseudo-relevance feedback inside the retriever (the hand-rolled
# equivalent the TypeScript pipeline implements)
.\.venv\Scripts\python -m langchain_lab.bench --mode prf

# the PGVector experiment: what LangChain's own vector store costs
.\.venv\Scripts\python -m langchain_lab.pgvector_probe

# remove everything the lab created in the database
.\.venv\Scripts\python -m langchain_lab.pgvector_probe --teardown
```

`--out <file.json>` writes the full report. `--limit N` scores only the
first N questions (handy while changing something).

**No LLM call. $0.00.** The models are local, the database is the one the
app already uses.

## The three modes, and why there are three

| mode | what it is | why |
|---|---|---|
| `production` | one embedding, one hybrid search, one cross-encoder pass | this is the number that goes in the comparison table: it is the same work the TypeScript pipeline does |
| `multi-query` | LangChain's `MultiQueryRetriever` around the same retriever | measures what LangChain's query expansion buys, and what it costs |
| `prf` | pseudo-relevance feedback INSIDE the retriever | the hand-rolled equivalent, so "LangChain's expansion" can be compared against "my expansion" on the same terms |

## The honesty rules this lab follows

1. **The same 79 questions.** `golden.py` reads `evals/golden-set.yaml`
   and applies the same scorable filter as `lib/eval/golden.ts`.
2. **The same metric code.** `metrics.py` is a port of
   `lib/eval/metrics.ts`, function for function. A different metric
   implementation would make the comparison meaningless.
3. **The same SQL.** `store.py` copies the four legs out of
   `lib/retrieval/search.ts` verbatim.
4. **The same weights.** The ONNX files under `models/Xenova/`, loaded by
   `onnxruntime`. Not a download, not a re-quantisation.
5. **No LLM.** The `MultiQueryRetriever` normally asks an LLM to write
   paraphrases. The lab plugs in a deterministic expander instead, so the
   run is repeatable and free. That is a limitation, and the write-up
   says so.

## What the lab writes to the database

Nothing, except in the `pgvector_probe` experiment, which creates the
schema `langchain_lab` and drops it again unless `--keep` is passed. The
`public` schema - the one the production pipeline uses - is never
written to.
