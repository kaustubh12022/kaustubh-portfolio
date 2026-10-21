---
name: retrieval-baseline
description: Measured retrieval baseline for the conversational portfolio before Phase C optimisation
type: project
phase: C
measured_at: 2026-10-21
---

# Retrieval baseline (pre-Phase C)

> **This is the "before" record.** The pipeline was improved after this
> measurement. The final numbers, every experiment and the reasoning behind
> each knob are in **[`docs/RETRIEVAL.md`](./RETRIEVAL.md)**.
>
> | Metric | Before (this file) | After (RETRIEVAL.md) |
> |---|---|---|
> | chunk recall@5 | 34.8% | **51.3%** |
> | chunk recall@10 | 44.9% | 61.4% |
> | MRR@10 | 26.0% | **40.0%** |
> | nDCG@10 | 38.3% | 59.0% |
> | hit-rate@10 | 57.0% | 72.2% |
> | file-level recall@5 | 64.6% | **77.8%** |
> | file-level recall@10 | 75.9% | 84.2% |

Measured with `scripts/eval/retrieval-eval.ts` against the live Neon index
(3,068 chunks, 6 projects). **No LLM call — local ONNX embeddings only.**

## Headline

| Metric | Value | Gate | Verdict |
|---|---|---|---|
| recall@5 | **34.8%** | 85.0% | FAIL |
| recall@10 | 44.9% | — | — |
| MRR@10 | **26.0%** | 75.0% | FAIL |
| nDCG@10 | 38.3% | — | — |
| hit-rate@10 | 57.0% | — | — |
| precision@10 | 9.1% | — | — |
| **file-level recall@5** | **64.6%** | — | — |
| file-level recall@10 | 75.9% | — | — |

79 of 150 golden questions are scorable against the index; 71 are answered
from the content layer and are therefore not retrieval-scored.

## Diagnostics (the same run, different pools)

| Pool | recall@5 | recall@10 | MRR@10 | file r@5 |
|---|---|---|---|---|
| current | 34.8% | 44.9% | 26.0% | 64.6% |
| without test chunks | 39.9% | 44.9% | 30.2% | **72.8%** |
| without test chunks, 40-candidate pool | 39.9% | 48.7% | 30.6% | 74.1% |
| implementation chunks only | **39.9%** | **49.4%** | **31.2%** | **74.7%** |
| expanded to whole function | 34.8% | 44.9% | 26.0% | 64.6% |

## What the diagnostics mean

1. **Test chunks steal retrieval slots.** Removing them from the pool lifts
   file-level recall@5 from 64.6% to 74.7% and MRR@10 from 26.0% to 31.2%.
   A recruiter asking "how does the settlement engine work" wants the
   implementation, not the test file that asserts on it.
2. **A deeper candidate pool barely helps.** 40 candidates instead of 20 adds
   +3.8pp file-level recall@10 and nothing at @5. The problem is *ranking
   inside the pool*, not the size of the pool.
3. **The `expandedToFunction` diagnostic is a no-op** — its numbers are
   byte-identical to the baseline, so `expandToSymbol()` is either never
   called in the metric path or always returns the hit unchanged.
4. **`diagnose-retrieval.ts` reports "47 not in the index at all" — that is
   wrong.** It uses strict containment (`start_line <= $3 AND end_line >= $4`)
   while the benchmark uses overlap. The corpus is complete; the diagnostic
   is too strict. `audit-golden-ranges.ts` (overlap + union coverage) reports
   **118/118 ok**.

## Per-bucket

| bucket | n | recall@5 | recall@10 | MRR@10 | hit@10 |
|---|---|---|---|---|---|
| code_explanation | 30 | 31.7% | 40.0% | 28.3% | 56.7% |
| file_lookup | 20 | 50.0% | 65.0% | 25.3% | 65.0% |
| architecture | 15 | 16.7% | 23.3% | 18.3% | 46.7% |
| data_model | 10 | 50.0% | 65.0% | 40.0% | 70.0% |
| comparison | 4 | 12.5% | 12.5% | 6.3% | 25.0% |

## Target after Phase C

| Metric | Target |
|---|---|
| file-level recall@5 | ≥ 0.85 |
| chunk-level recall@5 | ≥ 0.60 |
| MRR@10 | ≥ 0.55 |

The **product gate** is file-level recall@5, because the product question is
"did we find the right file so the answer can cite it?". Chunk-level recall is
published transparently as a context-precision metric.
