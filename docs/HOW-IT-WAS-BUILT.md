# How I built a portfolio that answers questions about my own code

*This is the post-mortem of a project that started as a chat box and turned
into a retrieval-augmented generation system over my own repositories. It is
also the answer I give when someone asks "what did you actually build?"*

---

## The problem

A portfolio has a delivery problem. It is a page you hand to a recruiter, and
a recruiter reads it for ninety seconds. Projects get skipped. Bullet points
get skimmed. The one question that decides the interview — *"can you actually
explain your own work?"* — cannot be answered from a PDF.

So I wanted a portfolio where the visitor could **ask**, and the answer would
come from my source code rather than from a marketing sentence.

The hard part was never the chat box. It was the promise. If the assistant
says *"`findZeroSumSubsets` is in `app.js` lines 1608–1654"* and that is
wrong, the portfolio is worse than no portfolio — it is a lie with a
streaming animation.

That made the design goal very specific:

> **Every answer must be grounded in the source, and when it cannot be, it
> must say so.**

---

## Phase 0: decide what is true, and write it down

Before any code, I audited my own history.

I found a Supabase superuser password committed in a public repo. I found a
Mongoose model storing a plaintext copy of a password. I found a live Google
API key in a Firebase config. I found a committed Edge browser profile with
cookies and saved logins in it.

I also found that my **resume** claimed things my code did not support: a
"2,000+ jobs per day" number that the telemetry actually recorded as 3,360
scanned and 1,032 scored; a "39 test assertions" figure that was 44; a
multi-tenant isolation claim that the code did not enforce.

So I built a **claim ledger** — `content/claims.yaml` — where every claim has
a status (`supported` / `contradicted` / `partial`), the file and line range
that proves it, and an approved `publicWording` for the website.

Two rules came out of that, and they shaped everything after:

1. **Source code at a pinned commit is the authority. The resume is a claim,
   not evidence.**
2. **A contradicted claim is answered explicitly, not hidden.** If you ask
   about the plaintext password, the assistant tells you it was there, that I
   found it during this audit, and that I removed it.

There is a test that enforces the first rule. `tests/eval/evidence-paths.test.ts`
walks every evidence path in every YAML file and checks it against the live
index. If I write a file path that does not exist, **the build fails**. That
one test is why the paths in the ledger are still true.

---

## Phase 1: the index

The corpus is my own code: 3,068 line-exact chunks across six repositories,
243 files.

**Chunking is the part people get wrong.** My first version cut on line
numbers, which splits a function in half and leaves the model reading half a
function. The real version uses **tree-sitter** and cuts on the AST: a
function, a class, a method, a block. Each chunk carries a *contextual
header*:

```
repo: smartapply @ d3aebf723240
file: src/scorer.py
symbol: is_relevant_jd
kind: function
lines: 136-155
imports: logging, re, json
```

That header is what makes a chunk searchable. `to_tsvector('english', ...)`
mangles identifiers — `calculate_deepseek_cost` becomes
`'calcul':1 'cost':3 'deepseek':2` — so the index keeps a raw-text view
*and* a stemmed view *and* the raw symbol, and the retriever uses all three.

**The secret gate is the part I am proudest of.** Before a file is chunked,
it is scanned by 13 blocking rules: inline Postgres passwords, private key
blocks, JWTs, OpenAI `sk-` keys, Google `AIzaSy` keys, Supabase `sb_secret_`
keys, Stripe `nt_live_` keys, bearer tokens, and my own phone number and
email. One finding aborts the whole project.

It is not decorative. It caught a real Postgres password in `init_tables.js`
and a real Google API key in `firebase-config.js` — which is exactly why two
of my seven projects are not in the index. The gate did its job.

And it caught a bug **in the gate itself**. The phone rule anchored the
pattern with `\b`, so `9975526627` was caught but `919975526627` — the same
number with the country code glued on — was not. My phone number reached the
live vector store in five chunks. The fix tolerates `+91`, `91` and `0`
prefixes with optional separators, and there are now three regression tests
that all three forms are caught.

---

## Phase 2: the retriever, and measuring it honestly

Four legs, fused with Reciprocal Rank Fusion:

| Leg | What it finds |
|---|---|
| vector ANN | "what does this do" |
| tsvector / BM25 | the prose around the code |
| trigram | identifiers by name, including partial ones |
| substring | literals and error messages nothing else catches |

**The first measurement was 34.8% recall@5. That is bad, and knowing it was
bad is the whole story.**

Every subsequent decision came from a measurement, not from a preference. I
built a fast benchmark harness that caches the query embeddings on disk and
reproduces the authoritative benchmark exactly, so a change costs thirty
seconds to evaluate instead of four minutes. Then I changed **one thing at a
time**:

| Change | Effect |
|---|---|
| Exclude test files from the pool | **+9.5pp** file-level recall@5 |
| Weight the keyword leg 4× the vector leg | +3.2pp chunk recall@5 |
| Add a local cross-encoder reranker | **+13.2pp** file-level recall@5 |
| Drop "generic" query tokens | −4.4pp — **rejected** |
| IDF-weight the substring leg | neutral — **rejected** |
| Lower the vector-leg minimum length | worse — **rejected** |

Two of those findings surprised me.

**The biggest win came from reading the corpus, not from tuning.** 36% of
the indexed code is test files. They were winning every top slot on generic
vocabulary — "booking", "user", "job". Filtering them out (unless the
question itself asks about tests) was worth more than any ranking change.

**The lever that sounded cleverest made things worse.** Dropping query
tokens that appear in more than 2% of the corpus cost 8 points of recall. The
tokens that look generic in a corpus of English prose — "job", "booking" — are
exactly the domain vocabulary of a question. Throwing them away removed the
only link between the question and the code.

### The second stage: a cross-encoder, running locally

A bi-encoder embeds the question once and every chunk once, then compares
vectors. It never sees the question and the code *together*, so it can only
hope that "which jobs are worth scoring" lands near `is_relevant_jd`.

A cross-encoder reads both at once and outputs one number for the pair. It is
much more accurate and much more expensive — one forward pass per candidate —
so the architecture is two-stage: retrieve 40, rerank the top 20.

The part I care about: **the cross-encoder is a 23 MB ONNX model that runs in
the same process as the embeddings.** No model server, no Python runtime, no
second deployment, no API key. **Retrieval costs $0.00 per query.** The whole
pipeline is one Node process with two ONNX sessions in it.

---

## Phase 3: the part that makes it trustworthy

The model is allowed to cite a file and a line range. Then the **server**
re-reads the index and checks it.

- Is the path in the index at all?
- Is the range covered by a real chunk, or by the union of overlapping chunks
  with no gap?
- If the model quoted text, does the quoted text match the source exactly?

A citation that fails is **dropped**, the confidence is downgraded, and the
visitor is told how many were dropped. That is the difference between a
portfolio that sounds confident and a portfolio that is.

The visual layer follows the same rule. When the assistant decides to show a
code excerpt or a data model, the **server** attaches the real source from
the index. The model only ever chooses the file and the line range — it can
never supply the text, so a prompt injection cannot put arbitrary content in
the code viewer. There is a test that asserts exactly that.

---

## Phase 4: the parts that went wrong

Three bugs worth telling, because they are the actual work.

**Production was silently broken for a week.** The model weights were
bundled, the build was green, the deploy succeeded — and the live assistant
could not read a single line of code. The native ONNX runtime was not
traced into the serverless bundle. The site answered every code question
from a claim ledger and said so, politely, and I did not notice for days.

The fix was to force the WASM backend. The lesson was bigger than the fix:
**my health endpoint now probes every layer of the retrieval path separately
and names the one that failed.** A boolean `ok` would have hidden this for
another week.

**My benchmark was lying to me.** A diagnostic reported that 47 of 118 golden
evidence entries were "not in the index at all", which looked like a broken
corpus. It was not: the diagnostic used strict line-range *containment* while
the benchmark used *overlap*. A chunk covering 90% of an expected range is a
correct retrieval. The corpus was complete the whole time — and the two tools
disagreed because one of them was wrong.

**The promptfoo suite was grading nothing.** The assertions sat at the top
level of the YAML instead of inside `defaultTest`, and promptfoo v0.124 has
no top-level `assert` key. The resolved config showed `"assert": []`. Three
"groundedness" rubrics — the ones that were supposed to catch exactly the
failures this project is about — had never executed. The grader was also
pointing at an API key that 401s, because promptfoo does not substitute
`{{env.X}}` inside a provider config.

The fix was not to make the grader work. It was to **delete it**: the
rubrics became deterministic assertions over the structured payload, plus a
documented human audit of 30 answers. LLM-as-judge cost more than the
product it was judging, and it failed open. That is a better sentence in an
interview than any promptfoo score.

---

## Where it stands

| | |
|---|---|
| Corpus | 3,068 line-exact chunks, 6 repositories, 243 files |
| Retrieval | hybrid ANN + BM25 + trigram + substring, RRF, local cross-encoder rerank |
| chunk recall@5 | **51.3%** (was 34.8%) |
| file-level recall@5 | **77.8%** (was 64.6%) |
| MRR@10 | **40.0%** (was 26.0%) |
| Retrieval cost | **$0.00** per query |
| Cost per answer | ~$0.001 |
| Tests | 238 unit + 18 e2e, 0 LLM calls |

**What is still not good enough:** file-level recall@5 is 0.778 against a
target of 0.85, and I know exactly why — `all-MiniLM-L6-v2` is a
general-purpose *sentence* encoder and this is a corpus of Python, TypeScript,
Dart and SQL. The next experiment is a code-aware embedding model, re-embed,
re-measure. The harness to do it already exists.

**What I would tell the next person:** measure before you tune. Every
decision in this project that I am confident about is a decision I measured,
and two of the three biggest "improvements" I tried made the system worse.
