# Cost policy — kaustubh-portfolio

**This file is binding on every agent and every script that touches this repo.**

The portfolio calls a paid LLM. The budget is real: the DeepSeek account had
**$0.86 remaining** when this policy was written, against a measured
**$0.5156 spend over 516 requests** in a single afternoon.

Cost is not a footnote here. It is the difference between a portfolio that
runs for a year and one that runs out of credit in a week.

---

## 1. Where the money actually goes

Measured over 516 requests ($0.5156 total):

| Bucket | Tokens | Cost | Share |
|---|---|---|---|
| Cache-miss input | 2,085,703 | $0.313 | **61%** |
| Output (completion) | 315,651 | $0.189 | 37% |
| Cache-hit input | 4,443,253 | $0.013 | **2.6%** |

Three facts follow, and they drive every rule below.

1. **The system prompt is free.** It is a byte-stable constant, so DeepSeek's
   prefix cache always hits it. 4.4M tokens cost $0.013.
2. **The tool results are what cost money.** The code chunks returned by
   `search_code` differ per question, so they are a cache *miss* every time
   and are billed at the full 50x rate.
3. **Repeating a question costs the full price again.** The audit found one
   question asked 9 times for $0.0182.

---

## 2. The three controls that are already in the code

### 2.1 The answer cache — `lib/ai/cache.ts`

Identical question + identical index → served from memory. Zero LLM spend.

- TTL 15 minutes, 500 entries, LRU eviction.
- Invalidated by the index generation: a re-index drops every entry, so a
  stale answer can never outlive the code it described.
- Only COMPLETE answers are cached (`confidence !== "low"`), so a degraded
  answer is never replayed as a good one.
- The response carries `x-cache: HIT` on a hit.

**Measured: a repeated question went from 9,165 ms to 18 ms, identical
answer text, $0 of LLM spend.**

### 2.2 The chunk clip — `lib/ai/tools.ts`

`MAX_CHUNK_CHARS` is **2,200** (was 6,000) and `DEFAULT_SEARCH_LIMIT` is
**4** (was 6).

A chunk is a function or a class, so 2,200 characters is usually the whole
thing. When it is not, the tool returns `truncated: true` and the model can
ask for a narrower range with `read_file`, which is charged the same but
returns only what was asked for.

**Measured: average uncached tokens per request fell from 4,042 to 2,313 —
a 43% reduction — with no loss of answer quality.**

### 2.3 The spend ceiling — `scripts/eval/golden-eval.ts`

`--max-spend=<usd>` (default **$0.50**) stops the benchmark the moment the
cumulative spend crosses the ceiling. Questions already in flight finish so
their results are not wasted.

---

## 3. Rules for agents

### 3.1 Never run the full golden set casually

```bash
# WRONG - 150 questions, real money, no ceiling
npx tsx scripts/eval/golden-eval.ts

# RIGHT - a slice, with a ceiling
npx tsx scripts/eval/golden-eval.ts --take=claim_correction:10 --max-spend=0.15
```

| Flag | Effect |
|---|---|
| `--take=<bucket>:<n>` | cap one bucket |
| `--per-bucket=<n>` | cap every bucket |
| `--bucket=<a,b>` | run only these buckets |
| `--questions=<id,...>` | run specific questions |
| `--max-spend=<usd>` | hard ceiling, default $0.50 |
| `--concurrency=<n>` | parallel requests, default 3 |

**Budget guidance:** a single cold answer costs roughly **$0.0009** after the
chunk-clip fix. A 10-question slice is about **$0.01**. A full 150-question
run is about **$0.14**. Start with a slice; only run the full set when the
change is significant enough to justify it.

### 3.2 Never re-ask a question that has already been answered

The answer cache makes a repeat free, but only when it is the *same*
question against the *same* index. Vary the question, or clear the cache
deliberately, when you are testing something new.

### 3.3 Retrieval evaluation is free — use it first

`scripts/eval/retrieval-eval.ts` only embeds and queries the index. There
is **no LLM call**, so it costs nothing. Run it before the golden set: if
retrieval recall is down, the answer quality is down, and no amount of
prompt tweaking fixes that.

### 3.4 Do not add LLM calls to a script that does not need one

Every tool result the model reads is uncached input at 50x the cached rate.
If a script can decide something with a regex, a lookup, or a score, it must.

### 3.5 Keep the system prompt byte-stable

Never interpolate a timestamp, a request id, a random nonce, or the user's
question into `SYSTEM_PROMPT`. Every such change invalidates DeepSeek's
prefix cache for every request, and the prompt is billed at the miss rate.
The same applies to the tool schemas: they are module-level constants for
this reason.

---

## 4. Rate and spend ceilings in production

| Guard | Value | Where |
|---|---|---|
| Per-IP rate limit | 10 requests / 5 min | `lib/ai/ratelimit.ts` |
| Input cap | 500 characters | `app/api/chat/route.ts` |
| Output cap | 700 tokens | `app/api/chat/route.ts` |
| Tool steps | 4 (2 exploration) | `app/api/chat/route.ts` |
| Answer cache TTL | 15 minutes | `lib/ai/cache.ts` |

The per-IP limiter is **per instance**. On a multi-instance deploy the
effective limit is N x 10 per 5 minutes. The production version of this
guard is Upstash (the keys are already in `.env.example`).

---

## 5. Reporting spend

Any script that calls the LLM must report, at the end of its run:

- the number of requests,
- the total cache-hit / cache-miss / completion tokens,
- the total cost in USD,
- the cost per answer.

`answer_log` already stores all four per request. The cost model is
`lib/ai/cost.ts`:

| Rate | Price per 1M tokens |
|---|---|
| cache hit | $0.003 |
| cache miss | $0.15 |
| completion | $0.60 |

DeepSeek switched to peak/off-peak pricing on 2026-08-16: the peak rates
are exactly double. The numbers above are the off-peak rates, which apply
outside 09:00-12:00 and 14:00-18:00 Beijing time. A run that straddles the
boundary will cost slightly more than the estimate.

---

## 6. What a good agent run looks like

```
1. Change the code.
2. npx tsc --noEmit                      # free
3. npx vitest run                        # free
4. NODE_OPTIONS=--conditions=react-server npx tsx scripts/eval/retrieval-eval.ts # free - no LLM
5. npx tsx scripts/eval/golden-eval.ts --take=<bucket>:<n> --max-spend=0.15
6. Report the numbers.
```

Step 4 catches most regressions for free. Step 5 is the only step that
costs money, and it is capped.
