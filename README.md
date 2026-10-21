# Kaustubh Kale — conversational portfolio

A chat-first portfolio that answers questions about Kaustubh's education, projects, and source code with grounded answers, citations, and question-appropriate visuals.

**Status:** Phase 0 (truth foundation) + Phase 1 (design and chat shell) in progress.

## What is real right now

- The content layer is driven by YAML, validated with Zod.
- The claim ledger records what the old resume said vs what the code supports.
- The UI runs in **demo mode**: curated, accurate answers and real visual components. The live retrieval + DeepSeek agent lands in Phase 3.
- All screenshots in `public/media/` are real project assets. Missing UI captures are labelled `status: needed`, never replaced with mock screenshots.

## Quick start

```powershell
npm install
copy .env.example .env.local
npm run dev
```

Open `http://localhost:3000`.

### Environment

Fill `.env.local` when Phase 3 starts:

```
DEEPSEEK_API_KEY=
GOOGLE_GENERATIVE_AI_API_KEY=
NEXT_PUBLIC_SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

The service role key is server-only. Never prefix it with `NEXT_PUBLIC_`.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Next.js dev server |
| `npm run build` | Production build |
| `npm run typecheck` | TypeScript |
| `npm run lint` | ESLint |
| `npm test` | Vitest |
| `npm run test:e2e` | Playwright |
| `npm run eval` | promptfoo golden set (Phase 5) |
| `npm run index` | Build the code index (Phase 2) |
| `npm run capture` | Playwright asset capture (Phase 6) |

## Project structure

```
app/                  Next.js app router
components/chat/      chat shell, composer, messages, visual renderer
components/visuals/   project card, architecture, skills, claim ledger
content/              profile, projects, claims, metrics, assets, architecture
lib/content/          Zod schemas + YAML loader
lib/demo/             Phase 1 curated answers (replaced by the agent in Phase 3)
docs/                 resume corrections, asset capture guide
public/media/         real project assets
```

## The 7 phases

| Phase | Output |
|---|---|
| 0 | Truth foundation: claim ledger, project YAML, resume corrections, asset guide |
| 1 | Premium chat shell, design system, 3+ visual components, demo mode |
| 2 | Code ingestion, tree-sitter chunks, Supabase pgvector + FTS index |
| 3 | DeepSeek agent, retrieval tools, citations, rate limits, real streaming |
| 4 | 12 visual components, curated diagrams, code explorer, animated explainers |
| 5 | Golden set, promptfoo, Playwright, a11y/security/load gates |
| 6 | Real screenshots/videos, static project pages, deploy, monitoring |

Full plan: `C:\Users\kalek\.opencode\plan\conversational-portfolio-plan.md`.

## Truth rules

1. Source code at a pinned commit is the highest authority.
2. The resume is a claim, not evidence.
3. Every public metric has a method and a source.
4. Contradicted claims are answered explicitly, not hidden.
5. No fabricated screenshots, metrics, companies, or skills.

## Key docs

- `docs/RESUME_CORRECTIONS.md` — exact old → new resume bullets.
- `docs/ASSET_CAPTURE.md` — how to capture the missing screenshots and recordings.
- `content/claims.yaml` — the claim ledger the assistant uses.
