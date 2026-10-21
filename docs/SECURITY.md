# Security

**Scope.** This is the security posture of the conversational portfolio, written
honestly. It covers what the code does, the bug I found in my own secret
scanner, the two projects the indexer refused to index, and - the part most
write-ups leave out - what is still not fixed.

Everything below was verified against the code or the live deployment on
2026-10-22. Where a number is quoted, the command that produces it is next to
it.

---

## 1. The index is a publishing surface, so it has a gate

The portfolio answers questions with source code from six repositories. That
source code is **embedded and served to anyone who asks**. A secret in one of
those files does not stay in the repository - it ends up in a vector store and
in a public chat answer.

So the indexer has a hard gate: **nothing is chunked before its raw content
has been scanned**, and one blocking finding aborts the whole project.

`scripts/index/index.ts`, step 2, runs before step 3 (chunking):

```
for (const relPath of files) {
  findings.push(...scanContent(content, relPath).findings);
}
if (blockFindings.length > 0) { /* STATUS: ABORTED */ }
```

### The 13 blocking rules

`scripts/index/scan.ts` holds 12 pattern rules plus one heuristic rule, 13
rules that block in total:

| rule | matches |
|---|---|
| `postgres-url-inline-password` | `postgres://user:pass@`, `postgresql://user:pass@` |
| `mongodb-url-inline-password` | `mongodb://user:pass@`, `mongodb+srv://user:pass@` |
| `private-key-block` | `-----BEGIN ... PRIVATE KEY-----` |
| `jwt` | a three-segment `eyJ...` token |
| `openai-style-api-key` | `sk-` + 20+ chars |
| `google-api-key` | `AIzaSy` + 30+ chars |
| `supabase-secret-key` | `sb_secret_` + 10+ chars |
| `supabase-management-token` | `sbp_` + 20+ chars |
| `stripe-live-key` | `nt_live_` + 10+ chars |
| `authorization-bearer-token` | `authorization: bearer <token>` |
| `pii-personal-phone` | my own phone number, in any format (see §3) |
| `pii-personal-email` | my own email address |
| `hardcoded-secret-value` | a `password` / `api_key` / `apikey` key with a **quoted literal** value |

Two properties make this scanner usable rather than noisy:

- **Only quoted literals count.** `password: user.password` and
  `api_key: os.environ.get("X")` are not findings. A key inside a string
  (`console.error('API_KEY:')`) is not a finding either - the scanner checks
  the character before the key and refuses a match that sits inside quotes.
- **Placeholders are downgraded, not blocked.** A value that contains
  `your_`, `<`, `xxx`, `example`, `changeme`, `todo`, `mock`, `test-key`,
  `dummy`, `fake`, `none`, `null` or `undefined` produces a `warn`, not a
  block. `api_key: "YOUR_KEY_HERE"` does not stop a build.

**A finding never contains the secret.** `redact()` keeps the first four
characters and the length:

```
[BLOCK] js/firebase-config.js:14:14  google-api-key  AIza…(len=39)
```

That is the whole line you see in a build log. The key itself is never
printed, never stored in a finding row, and never written to a report.

### The allow-list is default-deny

`scripts/index/allowlist.ts` decides what may be indexed. A file is indexed
only when **all** of these hold:

1. it matches at least one `include` glob of its project, **and**
2. it matches no `exclude` pattern (24 global excludes + the project's own),
   **and**
3. it trips none of the 7 hard-deny substrings - `.env`, `node_modules`,
   `edge_profile`, `credential`, `secret`, `token.json`, `gmail_credentials`,
   **and**
4. its extension is not one of the 39 binary extensions (`.png`, `.wasm`,
   `.onnx`, `.pkl`, `.pdf`, ...), **and**
5. it survives the secret scan.

The order matters: the hard-deny list is applied *after* the include list, so
a project cannot opt a file back in. A glob like `**/*` cannot reach
`node_modules/.env` or `config/credentials.ts`.

`normalizePath()` collapses `.` and `..` segments before any pattern is
matched, so a path that tries to walk out of the repository
(`../../etc/passwd`) is normalised to `etc/passwd` and then has to pass the
include list like anything else. The glob compiler supports `*` (a run of
characters inside one path segment), `?` (exactly one character) and `**`
(any number of segments). Excludes are broader than includes: a plain pattern
also matches everything below that directory, and a single-segment glob such
as `*.min.js` matches the basename at any depth.

---

## 2. The two projects the gate stopped

### DayScore - blocked by the scanner

`DayScore/js/firebase-config.js` holds a live Firebase web API key. It
matches DayScore's include glob `js/**`, so it reaches the scanner, and the
scanner stops the project:

```
$ npm run index:dry -- --project=dayscore

>> dayscore  (DayScore @ 8043daf)
   files       : 10 allow-listed files
   findings    : 3 (2 block, 1 warn)
    [WARN]  js/firebase-config.example.js:30:5  config-placeholder-value  apiKey: YOUR…(len=12)
    [BLOCK] js/firebase-config.js:14:5   hardcoded-secret-value      apiKey: AIza…(len=39)
    [BLOCK] js/firebase-config.js:14:14  google-api-key             AIza…(len=39)
   STATUS      : ABORTED - 2 block-severity findings must be resolved before this project can be indexed
```

That is why DayScore is **not** in the index. The key is still in the git
history of that repository (see §5).

For the record, a Firebase *web* config `apiKey` is not a secret in the
usual sense - it identifies the project and is visible in every browser
request. What actually protects the data is Firestore security rules and
restricting the key by API and by domain in the Google Cloud console. The
scanner is deliberately stricter than the platform: it blocks, and the
decision to allow it is a human one that takes an explicit allow-list entry.

### C54-Casino - blocked at the allow-list, then fixed at the source

`C54-Casino/init_tables.js` used to carry a hardcoded Supabase **superuser**
Postgres URL. A superuser bypasses Row Level Security completely, so anyone
who cloned the repository could read and tamper with every row of the
production database.

The history is three commits:

| commit | what it did |
|---|---|
| `08533ed` | `Update Supabase keys` - the credential enters the history |
| `586d274` | `fix(security): remove hardcoded superuser credentials and tighten RLS` - the credential leaves the working tree and the password is rotated at the provider |
| `9b7592a` | the file is added to C54's `exclude` list, so it can never be chunked even if a copy comes back |

Today `init_tables.js` reads `process.env.DATABASE_URL`, and C54 indexes
cleanly:

```
$ npm run index:dry -- --project=c54
   files       : 5 allow-listed files
   findings    : 0 (0 block, 0 warn)
   chunks      : 181 chunks
   STATUS      : WOULD INDEX
```

**A false positive worth naming.** If `init_tables.js` were put back into the
allow-list, the scanner would still block it - twice - on the *documented
placeholder* connection strings in its own comments:

```
[BLOCK] 29:24  postgres-url-inline-password  post…(len=40)
[BLOCK] 48:39  postgres-url-inline-password  post…(len=40)
```

The shape `postgresql://user:pass@host` is what the rule looks for, and
`postgresql://postgres.<user>:<password>@db.<project-ref>.supabase.co`
has that shape. The scanner cannot tell a placeholder from a live credential
by shape alone. The allow-list is the place where that judgement is made
explicitly, which is why both layers exist.

---

## 3. The bug I found in my own scanner

This is the one worth reading.

### What happened

The PII rule for my own phone number was written as:

```ts
pattern: new RegExp(`\\b${PERSONAL_PHONE}\\b`, "g")
```

`\b` is a **word boundary**. A word character is `[A-Za-z0-9_]`, so a
boundary exists only where a word character meets a **non**-word character.

Now trace `919975526627` - the number with the country code glued on:

| position | text | boundary? |
|---|---|---|
| 0 | `\|9` | yes (start of string, next is a word char) - but the next 10 digits are `9199755266`, not `9975526627`, so the match fails here |
| 1 | `9\|9` | **no** - both sides are word characters |
| 2 | `9\|7` | **no** - both sides are word characters |

Every later position is inside the digit run, so no boundary ever appears
immediately before the number. **The regex could not match it, and the
scanner reported nothing.**

The same is true of a leading `0` (`09975526627`): the digit before the
number kills the boundary.

The reason `9975526627` alone *was* caught is that the string start counts
as a boundary. And `+91-9975526627` was caught because `+` and `-` are
non-word characters, so a boundary exists right before the digits. The gap
was exactly the case nobody tested: a **digit glued to the front of the
number**.

Measured, with the old pattern and the new one:

```
"9975526627"                old: true    new: true
"+91-9975526627"            old: true    new: true
"contact: +91 9975526627"   old: true    new: true
"919975526627"              old: false   new: true    <-- the miss
"tel: 09975526627"          old: false   new: true    <-- the miss
"99755266270"               old: false   new: false   (correctly not a match)
"9975526627abc"             old: false   new: false   (correctly not a match)
```

### What it cost

The Pawna dry run reported **0 findings**, so the project was indexed with
the phone number in it. The number was in **5 live chunks** in Neon,
embedded, searchable, and reachable through the assistant. A recruiter
asking for contact details would have got them out of the vector store.

### The fix

The leading `\b` is gone and the country-code prefix is explicit:

```ts
pattern: /(?:\+?91[\s-]?|0)?9975526627\b/g
```

- `(?:\+?91[\s-]?|0)?` - an optional `+91` / `91` / `0` prefix, with an
  optional space or hyphen after `91`. Optional, because the bare number is
  still a hit.
- `9975526627` - the number itself.
- `\b` - **only on the trailing edge**, and it is the right place for it: it
  rejects `99755266270` and `9975526627abc`, which are different numbers or
  different strings, while still matching every real formatting of mine.

The same pattern is used by `redactOwnerPii()`, so redaction and detection
can never disagree - which is the bug class that actually bites, because a
scanner that detects what the redactor cannot redact is a scanner that
reports a problem it does not fix.

### The regression tests

`tests/unit/indexer.test.ts`, the `scanContent - PII` block. The phone test
was widened from a single format to five, and every format now has to be
both **detected** and **redacted**:

```ts
it("flags all personal phone number formats (bare, +91-, and glued 91)", () => {
  const formats = [
    'phone = "9975526627"',        // bare
    'phone = "+91-9975526627"',    // +91 with a hyphen
    'phone = "919975526627"',      // 91 glued on      <- the regression
    'contact: +91 9975526627',     // +91 with a space
    'tel: 09975526627',            // leading zero
  ];
  for (const text of formats) {
    const result = scanContent(text, "profile.py");
    expect(result.ok, `Should flag: ${text}`).toBe(false);
    expect(result.findings.find((f) => f.rule === "pii-personal-phone")).toBeDefined();
    const redacted = redactOwnerPii(text);
    expect(redacted).not.toContain("9975526627");
    expect(redacted).toContain("[REDACTED_PHONE]");
  }
});
```

Two more tests in the same block cover the email address and the rule that a
finding must never contain the raw PII value.

The Pawna project was then re-indexed with `--redact-pii`, and the index was
verified directly in SQL rather than by trusting the scanner:

```sql
SELECT count(*) FROM chunks WHERE content LIKE '%9975526627%';
--  0
```

That `0` is the number that matters. The verification is a query against the
index, not a re-run of the tool that produced it.

---

## 4. Deployment credentials

### Server-only separation

Eleven modules begin with `import "server-only"`:

```
lib/ai/cache.ts        lib/ai/citations.ts   lib/ai/cost.ts
lib/ai/ratelimit.ts    lib/ai/spend.ts       lib/ai/tools.ts
lib/content/datamodel.ts  lib/content/load.ts
lib/retrieval/db.ts
app/api/chat/route.ts  app/api/health/route.ts
```

`server-only` is not a convention here - it is a build-time error. If any of
these modules is pulled into a client bundle, `next build` fails. That is the
whole defence against `DATABASE_URL` ending up in browser JavaScript.

The one deliberate exception is `lib/retrieval/pg.ts`: the `server-only`
package throws when the module is loaded outside a React Server Component
context, and the `tsx` CLI in `scripts/index` has to be able to use the pool
factory. So the guard sits on the app-facing wrapper (`lib/retrieval/db.ts`)
and the low-level plumbing stays importable from the CLI.

### Nothing secret is `NEXT_PUBLIC_`

The only `NEXT_PUBLIC_` variable in the codebase is `NEXT_PUBLIC_SITE_URL`,
and it is a URL:

```
app/layout.tsx:36          process.env.NEXT_PUBLIC_SITE_URL
app/robots.ts:3            process.env.NEXT_PUBLIC_SITE_URL
app/sitemap.ts:5           process.env.NEXT_PUBLIC_SITE_URL
app/projects/page.tsx:9    process.env.NEXT_PUBLIC_SITE_URL
app/projects/[slug]/page.tsx:25
```

`DEEPSEEK_API_KEY`, `DATABASE_URL`, `DATABASE_URL_UNPOOLED` and
`MCP_AUTH_TOKEN` are server variables with no prefix, so Next.js refuses to
inline them into the client bundle. `SUPABASE_SERVICE_ROLE_KEY` and
`NEXT_PUBLIC_SUPABASE_URL` are not in `.env.example` any more and `grep`
finds no reference to either in `lib/`, `app/`, `components/` or `scripts/`.
The app talks to Neon, not to Supabase. `@supabase/supabase-js` is still
listed in `package.json` even though nothing imports it - an unused
dependency on the cleanup list, not a live integration.

To check the bundle yourself:

```bash
grep -rE "postgresql://|sk-[A-Za-z0-9]{20,}|AIzaSy" .next/static/ && echo LEAK || echo clean
```

### The MCP endpoint

`POST /mcp` serves the line-exact source of every indexed repository. It
takes a bearer token from `MCP_AUTH_TOKEN`:

- **Token set**: the request must carry `Authorization: Bearer <token>`. The
  comparison is constant-time (`secretsMatch` compares the whole buffer and
  folds the difference with `|=`, so the response time does not leak the
  token).
- **Token not set, in production**: the route returns **401** and logs an
  error once per process. It fails closed.
- **Token not set, in local development**: the endpoint is open. That is a
  deliberate development default - the data is public and the surface is
  read-only.

Verified against the live deployment on 2026-10-22:

```bash
$ curl -s -o /dev/null -w "%{http_code}" -X POST \
    https://kaustubh-portfolio-navy.vercel.app/mcp \
    -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
401
```

**The recommendation stands anyway: set `MCP_AUTH_TOKEN` in production.**
Failing closed means the endpoint is useless, not that it is safe - and the
moment the code is changed to "fail open" for a demo, the fallback is silent.
A token that is explicitly set is a decision; a missing variable is an
accident waiting to become an incident.

The endpoint also has a per-IP rate limit of 60 requests per 5 minutes, and
it answers `GET /mcp` with `405` because the current MCP revision removed the
GET stream.

---

## 5. What is still not fixed

These are open, and they are listed here rather than in a "future work"
section at the bottom of a roadmap.

### No bot check on `/api/chat`

`POST /api/chat` has a per-IP rate limit and a spend ceiling, but nothing
that distinguishes a browser from a script. A crawler that ignores the rate
limit by rotating IPs still spends the budget.

### The rate limiter is in-process and per-instance

`lib/ai/ratelimit.ts` keeps its counters in a `Map` in the memory of one
Node process. That means:

- the budget **resets on every deploy**,
- it is **not shared** between instances - on a fleet the effective limit is
  N times the per-IP limit,
- it keys on the first `x-forwarded-for` entry, which is **client-supplied**.
  Behind a proxy that header is trustworthy; if the app is ever reachable
  without a proxy that rewrites it, the key is whatever the caller says it
  is. The current deployment is on Vercel, which sets it.

The interface (`check(key) -> allowed, retryAfterSeconds`) is deliberately
the shape a shared backend would need. Upstash Redis is the obvious
implementation and was removed from `.env.example` because nothing was wired
up; nothing here depends on it.

### The spend ceiling is per-instance, too

`lib/ai/spend.ts` counts the day's spend in a module-level variable. It is
exact for one process and an approximation for a fleet. It is a backstop
against a runaway loop or a miswritten benchmark - **not** a billing control.
A real billing control belongs in the provider's own budget settings, and the
owner should set one there.

### Credentials still exist in the git history of three public repositories

The working trees are clean. The history is not.

```bash
$ git -C C54-Casino      log --oneline --all -S "postgres://"
$ git -C DayScore        log --oneline --all -S "AIzaSy"
5c4dc3d Initial commit: DayScore v1.0 with PWA and Firebase Sync
$ git -C Pawna-camping   log --oneline --all -S "plainPassword"
```

The rotation is the part that actually protects anything, and the rotation
of the C54 database password is done. The history rewrite - `git filter-repo`
with `--replace-text` on each of the three repositories - is **deferred**,
because rewriting the history of a public repository breaks every fork and
open pull request, and that is a decision a human should make on purpose
rather than a side effect of a cleanup script.

Until it happens, the honest statement is: *the credential in the C54 history
is rotated and no longer valid; the DayScore Firebase key is still valid at
the Google Cloud level and is still in that repository's initial commit.*

---

## 6. Verify it yourself

Every claim above has a command.

### Secret scan over the whole history

```bash
# install once: https://github.com/gitleaks/gitleaks
gitleaks detect --no-banner                       # the working tree
gitleaks detect --log-opts=--all --no-banner      # every commit, every branch
```

### The phone number is not in the index

```bash
psql "$DATABASE_URL_UNPOOLED" -c \
  "SELECT count(*) FROM chunks WHERE content LIKE '%9975526627%';"
```

Expected: `0`. This is the query that verified the redaction, and it is a
query against the index rather than a re-run of the tool that wrote it.

### The indexer refuses a project that contains a secret

```bash
npm run index:dry -- --project=dayscore    # -> ABORTED, 2 block findings
npm run index:dry -- --project=c54         # -> WOULD INDEX, 0 findings
```

`--dry-run` writes nothing.

### The deployed app is healthy, and the layers are named

```bash
curl -s https://kaustubh-portfolio-navy.vercel.app/api/health | python -m json.tool
```

The response separates the layers, so a failure names itself:

```json
{
  "ok": true,
  "chunks": 3068,
  "projects": 6,
  "embeddingModel": "Xenova/all-MiniLM-L6-v2",
  "retrieval": {
    "embedding": { "ok": true, "detail": "loaded and embedded in 513ms, 384 dims" },
    "database":   { "ok": true, "detail": "read 6 manifest rows in 28ms" },
    "search":     { "ok": true, "detail": "3 hits in 299ms, top=src/ai_engine.py:59" },
    "reranker":   { "ok": true }
  },
  "spend": { "usdToday": 0, "ceilingUsd": 2, "remainingUsd": 2 }
}
```

The `reranker` layer exists because a missing cross-encoder is a **silent**
degradation: the search still returns hits, they are just ranked badly, and
nothing else would have said so.

### The MCP endpoint needs a token

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  https://kaustubh-portfolio-navy.vercel.app/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
# 401
```

### No secret in the client bundle

```bash
grep -rE "postgresql://|sk-[A-Za-z0-9]{20,}|AIzaSy" .next/static/ && echo LEAK || echo clean
```

### The scanner itself still passes

```bash
npm test -- tests/unit/indexer.test.ts
```

---

## 7. The summary

| area | state |
|---|---|
| allow-list | default-deny, 24 global excludes, 7 hard-deny substrings, 39 binary extensions, path normalisation against traversal |
| secret scan | 13 blocking rules, 1 warning rule, values redacted in every finding |
| index gate | every allow-listed file scanned before chunking; one block aborts the project |
| PII | phone and email blocked, redacted in place, verified with a SQL count of `0` |
| deployment keys | 10 `server-only` modules; one `NEXT_PUBLIC_` variable, and it is a URL |
| `/mcp` | bearer token required in production, verified `401`; rate limited |
| open | no bot check; per-instance rate limiter and spend ceiling; git history not yet scrubbed |
