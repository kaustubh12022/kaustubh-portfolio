import type { Claim, Profile, Project } from "@/lib/content/schemas";
import type { DemoAnswer } from "@/lib/types/chat";

export type DemoContext = {
  profile: Profile;
  projects: Project[];
  claims: Claim[];
};

export function buildDemoAnswer(
  rawInput: string,
  context: DemoContext,
): DemoAnswer {
  const input = rawInput.toLowerCase();

  // --- Specific project questions -----------------------------------------
  if (input.includes("smartapply") || input.includes("job pipeline") || input.includes("job automation")) {
    if (
      input.includes("how") ||
      input.includes("work") ||
      input.includes("score") ||
      input.includes("cost") ||
      input.includes("architecture") ||
      input.includes("data model")
    ) {
      return {
        text:
          "The cost control is the interesting part. A pandas/regex filter runs before the model. Identical job descriptions hit `jd_cache`. The first DeepSeek call is serial to warm the provider cache, then the rest fan out with `asyncio.gather`. Each score is JSON-validated before it is stored.\n\nThe honest caveat: the Flask API has no auth and Supabase RLS is disabled in the audited schema, so it is not exposed publicly.",
        visual: { kind: "architecture", projectId: "smartapply" },
        evidence: [
          "src/scorer.py:549-559",
          "src/ai_engine.py:38-56",
          "full_matrix_results.json",
        ],
        followUps: [
          "How does the SmartApply filter work?",
          "What did SmartApply's filter remove?",
          "How does SmartApply tailor resumes?",
        ],
      };
    }

    return {
      text:
        "SmartApply is a six-stage job-automation pipeline. It scrapes postings, filters out roles that do not fit with regex rules, scores the survivors with DeepSeek, tailors an ATS resume for each shortlisted job, renders PDFs with Playwright, and tracks applications in a React dashboard.\n\nThe strongest measured result is the filter: **3,360 raw postings became 1,032 scored** in a recorded batch — 69% fewer model calls. It is a working prototype, not a hosted product.",
      visual: { kind: "project", projectId: "smartapply" },
      evidence: ["full_matrix_results.json", "src/pdf_generator.py"],
      followUps: [
        "How does the SmartApply filter work?",
        "Show me the SmartApply architecture",
        "What is missing from SmartApply?",
      ],
    };
  }

  if (input.includes("pawna") || input.includes("booking") || input.includes("camp")) {
    if (
      input.includes("architecture") ||
      input.includes("flow") ||
      input.includes("how") ||
      input.includes("data model")
    ) {
      return {
        text:
          "A visitor picks a property, dates, guests, and a package. The Express API checks blocked dates, capacity, and weekday/weekend pricing, then writes a booking. Owners and managers get role-scoped dashboards.\n\nIt is live, but I label it honestly: one Express monolith, three properties under one owner at audit time, and booking creation has no transaction or lock yet.",
        visual: { kind: "architecture", projectId: "pawna" },
        evidence: ["backend/controllers/bookingController.js", "backend/middleware/authMiddleware.js"],
        followUps: [
          "What would you fix in Pawna first?",
          "Is Pawna multi-tenant?",
          "Show me the Pawna data model",
        ],
      };
    }

    return {
      text:
        "Pawna is a multi-property booking platform for lake camping. Visitors check availability, configure guests and packages, and book. Owners and managers get role-scoped dashboards for properties, bookings, blocked dates, and revenue.\n\nThe engineering is real: weekday/weekend pricing, capacity overlap checks, JWT access, and Cloudinary media. The caveats are real too: no booking transaction, and the live audit showed three properties under one owner — not the “5+ businesses” on my old resume. An earlier version stored a plaintext shadow copy of the password. I found it during this audit and removed it; purge-plaintext-passwords.js scrubs existing rows.",
      visual: { kind: "project", projectId: "pawna" },
      evidence: ["backend/controllers/bookingController.js", "backend/models/User.js"],
      followUps: [
        "Show me the Pawna architecture",
        "What would you fix in Pawna first?",
        "Is Pawna multi-tenant?",
      ],
    };
  }

  if (input.includes("c54") || input.includes("settlement") || input.includes("casino")) {
    if (
      input.includes("how") ||
      input.includes("settle") ||
      input.includes("algorithm") ||
      input.includes("architecture") ||
      input.includes("data model")
    ) {
      return {
        text:
          "The settlement engine turns each player's round scores into a net balance, then finds the minimum set of transfers. For up to 15 players it uses exact subset DP; larger groups fall back to a greedy pass. Everything is integer paise, so there is no floating-point drift.\n\nThe app is host-authoritative: the host writes the session JSON, guests read it over Supabase Realtime. It is not a playable multiplayer casino.",
        visual: { kind: "architecture", projectId: "c54" },
        evidence: ["app.js", "test_suite.js"],
        followUps: [
          "Show me the C54 data model",
          "What does the C54 test suite cover?",
          "What is the C54 security issue?",
        ],
      };
    }

    return {
      text:
        "C54 is not a casino. It is a host-authoritative card-score tracker and settlement engine. The host enters rounds; guests see a live scoreboard over Supabase Realtime. At the end, the engine computes each player's net balance and finds the minimum transfers with exact subset DP for up to 15 players, using integer paise. It has 44 assert() call sites.\n\nThe repo currently contains hardcoded Supabase credentials, so I am rotating them before linking the live demo.",
      visual: { kind: "project", projectId: "c54" },
      evidence: ["app.js", "test_suite.js", "init_tables.js"],
      followUps: [
        "How does the C54 settlement engine work?",
        "Show me the C54 architecture",
        "What is the C54 security issue?",
      ],
    };
  }

  if (input.includes("aura") || input.includes("voice") || input.includes("skincare")) {
    return {
      text:
        "Aura is a Gemini Live voice agent built for a skincare support assessment. The browser streams 16 kHz PCM over a WebSocket; a relay forwards it to Gemini Live, streams 24 kHz audio back, and handles barge-in. The model can call order lookup and cancellation tools, and the call ends with a structured summary plus a deterministic fallback.\n\nIt has 129 test declarations. It is published with permission and labelled as an assessment project.",
      visual: { kind: "project", projectId: "aura" },
      evidence: ["server/geminiLiveRelay.js:16-56", "server/tools.js"],
      followUps: [
        "How does Aura handle barge-in?",
        "What tools can Aura call?",
        "Show me the Aura audio path",
      ],
    };
  }

  if (
    input.includes("personal ai") ||
    input.includes("personal-ai") ||
    input.includes("flutter") ||
    input.includes("productivity")
  ) {
    return {
      text:
        "Personal AI OS is a Flutter + Supabase assistant — not the Python/Ollama stack on my old resume. Chat actions create tasks, log expenses, and set budgets. A Deno edge function first tries a regex fast-path, then calls Gemini with a JSON intent contract, with Groq as fallback. The chat renders inline charts and tables.\n\nIt is an early prototype: no auth, no RLS, no voice, and no working RAG yet. I would rather show that honestly than pretend it is a finished AI OS.",
      visual: { kind: "project", projectId: "personal-ai-os" },
      evidence: ["supabase/functions/chat/index.ts:92-614", "lib/features/chat"],
      followUps: [
        "How does Personal AI OS route intents?",
        "Does Personal AI OS use RAG?",
        "What is the Personal AI OS stack?",
      ],
    };
  }

  // --- Cross-cutting questions -------------------------------------------
  if (
    input.includes("rag") ||
    input.includes("vector") ||
    input.includes("portfolio") ||
    input.includes("retriev") ||
    input.includes("citation") ||
    input.includes("eval")
  ) {
    return {
      text:
        "I do not have a production RAG project in my earlier work. Personal AI OS has an unused `second_brain.embedding` table, but nothing writes or searches it — so I will not call that RAG.\n\nThis portfolio is the first real implementation: hybrid pgvector + full-text retrieval over AST chunks, an agent that reads exact files, and a citation validator. The point is not to say “RAG”; it is to show the retrieval, the evidence, and the failure modes.",
      visual: { kind: "claims", claimIds: ["rag-vector", "mcp"] },
      evidence: ["personal-ai-os/supabase/migrations", "content/claims.yaml"],
      followUps: [
        "How does the portfolio retrieve code?",
        "Show me the eval plan",
        "What is missing from the RAG plan?",
      ],
    };
  }

  if (input.includes("java") || input.includes("spring")) {
    return {
      text:
        "Java is real, but the old resume overstates it. I use Java for DSA and used it in my internship. Across the audited folders there is **no Spring Boot or MySQL project** — the hospital repo is Node/Express/MongoDB, and MedFlow as described does not exist.\n\nIf you are hiring for Java backend, that is the gap I am fixing with a real Spring Boot service. I will not show a renamed Node app as Java experience.",
      visual: { kind: "claims", claimIds: ["java-spring", "medflow"] },
      evidence: ["Desktop audit 2026-10-19", "hospital-management-system-/package.json"],
      followUps: [
        "What Java work is real?",
        "Why is there no Spring project?",
        "What are you building next?",
      ],
    };
  }

  if (
    input.includes("skill") ||
    input.includes("stack") ||
    input.includes("tech") ||
    input.includes("know") ||
    input.includes("shipped") ||
    input.includes("coursework") ||
    input.includes("building")
  ) {
    return {
      text:
        "Here is the honest split. **Shipped:** Python/AsyncIO, DeepSeek, React, Node/Express, MongoDB, Supabase, Flutter/Dart, Gemini Live, and Playwright. **Internship:** Java, SQL, JDBC, REST. **Coursework:** Spring Core, Hibernate/JPA, MySQL, Docker, Kubernetes. **Building:** RAG with pgvector, MCP tool servers, and agentic retrieval.\n\nNo proficiency bars — the code is the evidence. If a skill has no project behind it, I label it as coursework or building.",
      visual: { kind: "skills" },
      evidence: ["content/profile.yaml", "content/claims.yaml"],
      followUps: [
        "What is shipped vs coursework?",
        "What are you building?",
        "Show me the SmartApply architecture",
      ],
    };
  }

  if (
    input.includes("claim") ||
    input.includes("true") ||
    input.includes("resume") ||
    input.includes("honest") ||
    input.includes("medflow") ||
    input.includes("neon")
  ) {
    return {
      text:
        "I keep a claim ledger because my old resume had numbers the code did not support. The **3,360 → 1,032** batch is real. The **2,000+/day** and **>80% cost** claims are not. CampFlow's “5+ owners” is unverified; the live audit showed three properties under one owner. MedFlow and Neon-Pulse have no code.\n\nThe portfolio is built to say that out loud. Ask me about any claim and I will show the evidence — or the gap.",
      visual: {
        kind: "claims",
        claimIds: ["smartapply-volume", "campflow-owners", "medflow", "neon-pulse"],
      },
      evidence: ["content/claims.yaml", "full_matrix_results.json"],
      followUps: [
        "Which claims are contradicted?",
        "Show me the SmartApply numbers",
        "What about MedFlow?",
      ],
    };
  }

  // --- Default ------------------------------------------------------------
  return {
    text: `I'm ${context.profile.name.split(" ")[0]} — a Graduate Engineer in Pune. I build AI automation, agentic tools, and backend systems. The short version: SmartApply (a DeepSeek job pipeline), Pawna (a live booking platform), C54 (a settlement PWA), Aura (a Gemini Live voice agent), and Personal AI OS (Flutter + Supabase).\n\nAsk me how any of them works, or ask me where the code does not match the resume — I will answer that too.`,
    visual: { kind: "profile" },
    evidence: ["content/profile.yaml"],
    followUps: [
      "What did you build?",
      "How does SmartApply work?",
      "Where does the resume not match the code?",
    ],
  };
}

export function suggestedQuestions(context: DemoContext) {
  const names = context.projects
    .filter((item) => item.featured)
    .slice(0, 2)
    .map((item) => item.name);

  return [
    "What did you build?",
    "How does SmartApply work?",
    `Show me the ${names[0] ?? "project"} architecture`,
    "Does your resume match the code?",
  ];
}
