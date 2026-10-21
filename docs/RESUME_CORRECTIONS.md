# Resume corrections — claim-by-claim

**Purpose:** The portfolio must not repeat claims the code disproves. This document maps every old claim to a verified replacement. It is the source of truth for the next resume build.

**Rules**
- Four-digit years only (`2022 - 2026`).
- Resume sections: summary, education, skills, projects, experience, certifications, achievements.
- Three projects per resume, 3 + 2 + 2 bullets, 15–25 words per bullet.
- 18–20 skills from the verified inventory only.
- One page, ATS-safe.

---

## 1. Header and links

| Old | New | Why |
|---|---|---|
| `github.com/kaustubhkale12` | `github.com/kaustubh12022` | The old account has 0 public repos; all 19 repos are under `kaustubh12022`. |
| `linkedin.com/in/kaustubhkale12` | Unchanged | Correct. |
| Phone `+91-9975526627`, email `kaustubh.kale.work@gmail.com` | Unchanged | Correct. |

---

## 2. Summary

**Old**
> Graduate Engineer skilled in Java, Python, SQL, REST APIs, DSA, and full-stack development with internship experience in modular backend services, database optimization, responsive UI, and AI-driven automation pipelines. Strong foundation in Spring Boot, MERN stack, RAG & Vector Search, and Generative AI / DeepSeek integrations.

**New**
> Graduate Engineer (B.E. IT, 2026) building AI automation, agentic tools, and backend systems. Shipped a DeepSeek job-scoring pipeline, a live booking platform, and a Gemini Live voice agent. Strong in Python/AsyncIO, React/Node, SQL, and shipping measured work.

**Why:** Removes Spring Boot and RAG/Vector Search, which have no public implementation. Adds the three real projects.

---

## 3. Projects — developer / AI resume set

### 3.1 SmartApply (replace the old JobHunt / AutoApply block)

**Old claims:** 2,000+ postings/day, >80% cost reduction, WeasyPrint rendering.

**Two different numbers — never merge them:**
- The **filter** cut the number of LLM scoring calls by **69.3%** (3,360 raw → 1,032 scored) in the recorded batch. This is a reduction in *calls*, not in token cost.
- **Prompt-prefix caching** cut token cost by **62.57%** against baseline, with a **99.77%** cache-hit rate, per the project's own `SUMMARY.md`. The first scoring call runs serially to warm the provider cache, then the rest fan out with `asyncio.gather`.

Neither number reaches 80%.

**New bullets**
1. Built an asynchronous Python pipeline that scraped 3,360 postings in a recorded batch, filtered 2,328, and scored 1,032 with DeepSeek JSON output.
2. Cut LLM scoring calls by 69% with regex and pandas prefiltering, a job-description cache, and a serial warm-up before `asyncio.gather` fan-out.
3. Cut token cost 62.57% against baseline with DeepSeek prompt-prefix caching, measured at a 99.77% cache-hit rate.

**Alternative bullet** (swap for bullet 3 on a backend-leaning resume): Tailored ATS resumes with locked facts and rendered PDFs via Jinja2 + Playwright; persisted scores, skill gaps, and applications in SQLite and Supabase.

**Evidence:** `full_matrix_results.json` (`found_initial: 3360`, `reached_scoring: 1032`), `SUMMARY.md` (99.77% cache-hit rate, 62.57% cost savings, deepseek-chat rate table), `src/ai_engine.py:59-74` (`calculate_deepseek_cost`, three-rate model), `src/scorer.py:538-562` (serial warm-up then `asyncio.gather`), `src/resume_tailor.py`, `src/pdf_generator.py`.

**Do not write:** "2,000+ daily", ">80% cost", "WeasyPrint", or "69% cost saving" — 69% is the reduction in *scoring calls*.

---

### 3.2 Pawna Camping (replace the CampFlow block)

**Old claims:** 5+ commercial owners, multi-tenant, REST microservices on Vercel, real-time push dashboards.

**Naming correction:** the project is **Lonavala Stays**, not CampFlow. `vite.config.js:26-27` sets `name: 'Lonavala Stays'` and `short_name: 'Lonavala'`, and the string "CampFlow" does not appear anywhere in either copy of the repository. "CampFlow: Hospitality Automation & Booking Suite" was a resume label that never reached the code. Never write "CampFlow" or that suite name.

**Stack (real):** React 19.2 + Vite 7 + Tailwind CSS v4 frontend on Vercel, Express 5 + Mongoose 9 API on Render, 8 Mongoose models, JWT role-scoped access. The 58 MB Flutter mobile app exists only as an untracked local copy and is not part of the public repo.

**New bullets**
1. Built a multi-property camping booking platform with React and Express covering availability checks, weekday/weekend pricing, and guest capacity rules.
2. Implemented JWT role scoping so owners and managers see only their properties, bookings, blocked dates, and revenue dashboards.
3. Deployed the React PWA on Vercel and the Express API on Render; integrated Cloudinary uploads, MongoDB models, and an installable PWA shell.

**Evidence:** `backend/controllers/bookingController.js`, `backend/middleware/auth.js`, `backend/models/`, `vite.config.js:26-27`, `vercel.json`, `render.yaml`.

**Do not write:** "CampFlow", "Hospitality Automation & Booking Suite", "5+ owners", "multi-tenant", "microservices", "real-time analytics push".

---

### 3.3 Aura (replace the MedFlow block)

**Old claims (MedFlow):** Spring Boot, MySQL, JPA/Hibernate, JWT RBAC, HIPAA, 40% report improvement.

**New bullets**
1. Built a Gemini Live speech-to-speech support agent with 16 kHz PCM input, 24 kHz scheduled playback, and barge-in interruption handling.
2. Implemented order lookup and cancellation tools inside the live session plus a structured post-call summary with a deterministic fallback.
3. Added 129 test declarations across unit, integration, and E2E suites for the audio relay, tool calls, and UI.

**Evidence:** `server/geminiLiveRelay.js`, `server/tools.js`, `server/summary.js`, `tests/`.

**Label:** "Hiring assessment project — published with permission."

**Do not write:** "MedFlow", "HIPAA", "40%", "122 tests / 100% coverage".

---

### 3.4 C54 (replace the Neon-Pulse block)

**Old claims (Neon-Pulse):** recursive pattern engine, 20+ difficulty tiers, zero-lag DOM. *(No code exists.)*

**Stack correction:** the repo is **vanilla JS ES6 modules + Supabase Postgres/Realtime + a PWA shell**. There is no React, no Node.js server, no Socket.IO, no Tailwind and no Vite. `package.json` has exactly one dependency, `pg`, used only by the one-shot DDL script `init_tables.js` and the test harness; `style.css` is 2,024 lines of hand-written CSS with a `:root` token block; `index.html:18` loads a single CDN script. Realtime is a Supabase `postgres_changes` subscription (`app.js:1192-1230`), not Socket.IO. `app.js` contains **zero** `setInterval` calls, so there is no game loop — the app records and settles real-card games played offline. The genuine technical centre is the settlement engine: subset-sum DP (`app.js:1608-1654`, `findZeroSumSubsets` with `Int32Array(1 << n)`) plus a greedy `minimumTransactions` pass (`app.js:1518-1607`).

**New bullets**
1. Built a host-authoritative card-score tracker PWA where the host writes session state and guests follow a live scoreboard over Supabase Realtime.
2. Implemented an exact subset-DP settlement engine for up to 15 players with greedy fallback and integer-paise arithmetic to avoid floating-point drift.
3. Wrote 39 assertions covering settlement correctness, balance math, and edge cases; shipped an installable, offline-capable PWA shell.

**Evidence:** `app.js:1518-1607,1608-1654,1192-1230`, `test_suite.js`, `manifest.json`, `package.json`, `style.css`.

**Do not write:** "Socket.IO", "React", "Node.js", "Tailwind", "Vite", "full-stack", "playable multiplayer casino", "Neon-Pulse".

---

### 3.5 Personal AI OS (use only on AI/GenAI-targeted resumes)

**Old claims:** Python, Ollama, LangChain, FastAPI, SQLite, low-latency voice, custom tool-calling agents.

**New bullets**
1. Built a Flutter + Supabase personal assistant where chat actions create tasks, log expenses, and set budgets with inline charts.
2. Wrote a Deno edge function that routes intents through a zero-token regex fast-path, then Gemini JSON contracts with Groq fallback.
3. Added 23 widget and unit tests plus Supabase Realtime sync across task, expense, and dashboard screens.

**Evidence:** `supabase/functions/chat/index.ts`, `lib/features/chat`, `test/`.

**Do not write:** Python, Ollama, LangChain, FastAPI, SQLite, voice, "tool-calling agents".

---

### 3.6 Personal Application Copilot (new — 7th project)

**Repo:** `https://github.com/kaustubh12022/personal-application-copilot` (HEAD `6e38dac`, 2 commits, 761 tracked lines excluding `package-lock.json`, 1 API route).

**What it is:** a Next.js 14 App Router chat app that answers job-application questions from a hand-written Markdown knowledge base, calling the DeepSeek REST API directly. The system prompt and the knowledge file are concatenated once at module scope (`app/api/chat/route.ts:42-54`) so the provider's automatic prefix cache always sees identical prefix bytes.

**New bullets**
1. Built a Next.js 14 chat app that answers job-application questions from a hand-written 113-line Markdown knowledge base using the DeepSeek REST API.
2. Kept the system prompt byte-stable at module scope so the provider's automatic prefix cache hits on every request, and cached repeat answers for 15 minutes in memory.
3. Enforced a 5-6 sentence answer budget with `[x]`/`[ ]` checkbox formatting and an explicit "I haven't built that" rule for anything outside the knowledge base.

**Evidence:** `app/api/chat/route.ts:5-40,42-62,84-97,148-153`, `context/knowledge_graph.md`, `package.json`.

**Do not write:** "RAG", "vector search", "retrieval" (the corpus is a hand-written file, nothing is retrieved or embedded), "96%+ cache hit" or "~90% cost saving" (the README's figures are not measured anywhere in the repo), "production-ready".

**Use it as a swap, never as a headline project.** It is 761 lines with no test suite, so it never displaces SmartApply, Pawna, Aura, C54 or Personal AI OS in the three-project set.

---

## 4. Experience (CWIPedia internship)

The internship is real; the percentage metrics are not artifact-backed.

**New bullets**
1. Built modular backend features with Java, SQL, JDBC, and REST APIs in two-week Agile sprints.
2. Optimized queries and request payloads using data structures and algorithms, and built responsive HTML5/CSS3/JavaScript UI.

**Do not write:** 30% reusability, 20% latency, 25% render, or any metric without a benchmark artifact.

---

## 5. Skills section

### Keep (verified by code or internship)
`Python`, `JavaScript`, `Java`, `SQL`, `HTML5`, `CSS3`, `AsyncIO`, `DeepSeek`, `Gemini`, `Prompt engineering`, `JSON schema validation`, `Playwright`, `React`, `Vite`, `Tailwind CSS`, `Node.js`, `Express`, `MongoDB`, `REST APIs`, `JDBC`, `Supabase`, `SQLite`, `PWA`, `Git/GitHub`, `Postman`.

### Label as coursework
`Spring Core`, `Hibernate/JPA`, `MySQL`, `Docker`, `Kubernetes`, `DSA`, `OOP`, `DBMS`.

### Label as currently building
`RAG with pgvector`, `MCP tool servers`, `Agentic retrieval`, `Next.js`, `AI SDK`, `TypeScript`.

### Remove until there is an artifact
`RAG & Vector Search` (as experience), `MCP & Tool Calling` (as shipped), `LangChain`, `FastAPI`, `n8n`, `Spring Boot` (as project experience), `Hibernate` (as project experience), `Selenium` (unless the QA resume), `REST Assured`, `TestNG`, `Kubernetes` (as experience).

---

## 6. Achievements

**Keep:** Lead NSS Coordinator, SKNSITS — coordinated 50+ volunteers.

**Remove:** "100% clean Git histories", "0 merge conflicts" and any other unverifiable absolute. Replace with a concrete action if needed: "Ran volunteer scheduling and reporting for campus drives."

---

## 7. Tailoring sets

| Target | Projects |
|---|---|
| AI / GenAI / agents / automation | SmartApply, Aura, Personal AI OS |
| Backend / full-stack / Java | SmartApply, Pawna Camping, C54 |
| QA / testing | SmartApply (pytest), Aura (Vitest/Playwright), C54 (assertions) — swap experience before projects per ATS invariant |

Optional swap, never a headline project: Personal Application Copilot (3.6) can replace the third project on an AI-targeting resume when a second DeepSeek integration helps, but it is a 761-line side project with no test suite.

---

## 8. Build step

1. Copy `Resume_Dev_Updated.tex` to `docs/resume/Resume_Dev_2026.tex`.
2. Apply the replacements above.
3. Compile, verify one page and four-digit years.
4. Update the portfolio `content/profile.yaml` if any bullet changes.
5. Leave the original `.tex` untouched until the new PDF passes review.

---

## 9. Content-layer ledger (mirrors `content/claims.yaml`)

| Claim | Status | Approved replacement |
|---|---|---|
| C54 built with React, Node.js, Socket.IO, Tailwind, Vite | contradicted | Vanilla JS PWA on Supabase Postgres + Realtime; the settlement engine is the real technical centre. |
| CampFlow: Hospitality Automation & Booking Suite | contradicted | The project is "Lonavala Stays" — React, Express, MongoDB on Vercel and Render. |
| SmartApply ranking with >80% cost reduction | unverified | Two real numbers: 69% fewer scoring calls (3,360 → 1,032) and 62.57% lower token cost from prompt-prefix caching at a 99.77% cache-hit rate. |

