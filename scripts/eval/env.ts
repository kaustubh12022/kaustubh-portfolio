/**
 * Load `.env.local` into `process.env` for the evaluation CLIs.
 *
 * `next dev` loads it automatically; a plain `tsx` process does not. The
 * evaluation scripts need the same variables the app has, so they read the
 * file themselves.
 *
 * Nothing is ever printed: the loader only copies KEY=VALUE pairs.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

/** The environment file the dev server uses. */
export const ENV_FILE = path.join(process.cwd(), ".env.local");

/**
 * Copy the variables of `.env.local` into `process.env`.
 *
 * Existing environment variables WIN: an explicit `DATABASE_URL` in the
 * shell overrides the file, so a CI run can point at a different database.
 *
 * @param keys the variables to copy. Defaults to the ones the app needs.
 */
export function loadEnv(
  keys: string[] = [
    "DATABASE_URL",
    "DATABASE_URL_UNPOOLED",
    "DEEPSEEK_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "KAUSTUBH_REPOS_ROOT",
  ],
): void {
  let raw: string;
  try {
    raw = readFileSync(ENV_FILE, "utf8");
  } catch {
    return; // no .env.local: the environment has to provide the values
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (!keys.includes(key)) continue;
    if (process.env[key]) continue; // the real environment wins
    process.env[key] = value;
  }
}

/**
 * Mask a secret so it can be printed safely.
 *
 * Keeps the first four characters (so the provider is still identifiable)
 * and replaces the rest with a fixed mask.
 */
export function mask(value: string | undefined): string {
  if (!value) return "(unset)";
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}***(${value.length} chars)`;
}
