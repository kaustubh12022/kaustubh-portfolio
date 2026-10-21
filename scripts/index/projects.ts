import os from "node:os";
import path from "node:path";

import type { ProjectDef, ProjectId } from "./types.js";

/**
 * Root folder that holds the local clones of the six source repositories.
 *
 * Override with the `KAUSTUBH_REPOS_ROOT` environment variable when the
 * repositories live somewhere else (CI, other machines, ...).
 */
export const REPOS_ROOT = process.env.KAUSTUBH_REPOS_ROOT
  ? path.resolve(process.env.KAUSTUBH_REPOS_ROOT)
  : path.join(os.homedir(), "Desktop", "GitHub projects");

/**
 * The manifest of projects that feed the retrieval index.
 *
 * Every SHA below is the full 40 character commit that was verified with
 * `git -C <repoPath> rev-parse HEAD`.
 */
export const PROJECTS: ProjectDef[] = [
  {
    id: "smartapply",
    name: "JobHunt-Automation",
    repoPath: path.join(REPOS_ROOT, "JobHunt-Automation"),
    repoUrl: "https://github.com/kaustubh12022/JobHunt-Automation.git",
    repoSha: "d3aebf723240a518f9b2b5985bbe850d76e0664c",
    defaultBranch: "main",
    include: [
      "src/**",
      "app.py",
      "run.py",
      "hunter_runner.py",
      "ats_verifier.py",
      // NOTE: `config.yaml` is deliberately INCLUDED. It contains no secrets and
      // its `ai.api_key` field is empty, which the scanner verifies at index
      // time (an empty value is not a block-severity finding).
      "config.yaml",
      "frontend/src/**",
      "tests/**",
      "templates/**",
      "standalone_dashboard/**",
      "setup_db.py",
    ],
    exclude: [],
    languages: ["python", "javascript", "jsx", "html", "css", "yaml", "markdown"],
  },
  {
    id: "pawna",
    name: "Pawna-camping",
    repoPath: path.join(REPOS_ROOT, "Pawna-camping"),
    repoUrl: "https://github.com/kaustubh12022/Pawna-camping.git",
    repoSha: "fc0491ad917e5f1ede14761297e84ea8bb122d06",
    defaultBranch: "fix/owner-password-and-pii-leak",
    include: ["backend/**", "src/**"],
    exclude: [],
    languages: ["javascript", "jsx"],
  },
  {
    id: "c54",
    name: "C54-Casino",
    repoPath: path.join(REPOS_ROOT, "C54-Casino"),
    repoUrl: "https://github.com/kaustubh12022/C54-Casino.git",
    repoSha: "686648e5b1d2b562f83bd9d10286914d04c8f9df",
    defaultBranch: "main",
    include: [
      "app.js",
      "index.html",
      "style.css",
      "sw.js",
      "init_tables.js",
      "manifest.json",
    ],
    exclude: [],
    languages: ["javascript", "html", "css", "json"],
  },
  {
    id: "personal-ai-os",
    name: "personal-ai-os",
    repoPath: path.join(REPOS_ROOT, "personal-ai-os"),
    repoUrl: "https://github.com/kaustubh12022/personal-ai-os.git",
    repoSha: "49ae86f5ed341961ffbdcd49a10158acb1b6915c",
    defaultBranch: "master",
    include: ["lib/**", "supabase/functions/**", "supabase/migrations/**", "test/**"],
    exclude: [],
    languages: ["dart", "typescript", "sql"],
  },
  {
    id: "aura",
    name: "aura-skincare-voice-cx",
    repoPath: path.join(REPOS_ROOT, "aura-skincare-voice-cx"),
    repoUrl: "https://github.com/kaustubh12022/aura-skincare-voice-cx.git",
    repoSha: "20c3535007750a7cfcc886ebdf0f73864f9f6c70",
    defaultBranch: "main",
    include: ["server/**", "src/**"],
    exclude: [],
    languages: ["javascript", "jsx"],
  },
  {
    id: "dayscore",
    name: "DayScore",
    repoPath: path.join(REPOS_ROOT, "DayScore"),
    repoUrl: "https://github.com/kaustubh12022/DayScore.git",
    repoSha: "8043dafc481c5d9481d9391924cebbe881e39d16",
    defaultBranch: "main",
    include: ["js/**", "index.html", "css/**", "sw.js"],
    exclude: [],
    languages: ["javascript", "html", "css"],
  },
  {
    id: "copilot",
    name: "personal-application-copilot",
    repoPath: path.join(REPOS_ROOT, "personal-application-copilot"),
    repoUrl: "https://github.com/kaustubh12022/personal-application-copilot.git",
    repoSha: "6e38dac22a8c94e60dd8d9c37b187700863e5d34",
    defaultBranch: "main",
    include: ["app/**", "context/**", "lib/**"],
    exclude: [".env*", "*.local"],
    languages: ["typescript", "javascript", "markdown"],
  },
];

/** Look up a single project by id. */
export function getProject(id: string): ProjectDef | undefined {
  return PROJECTS.find((p) => p.id === (id as ProjectId));
}

/** Repository folder name, derived from the remote URL. */
export function repoName(project: ProjectDef): string {
  const base = project.repoUrl.replace(/\.git$/i, "").replace(/\/+$/, "");
  const parts = base.split(/[\\/]/);
  return parts[parts.length - 1] || project.name;
}
