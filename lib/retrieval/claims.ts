/**
 * The claim ledger.
 *
 * `content/claims.yaml` is the single source of truth for what the assistant
 * is allowed to say about the owner's work. Every claim carries:
 *
 *   - `status`        - verified | partial | unverified | contradicted
 *   - `evidence`      - what was actually found during the audit
 *   - `source`        - where that evidence lives
 *   - `publicWording` - the APPROVED sentence. The assistant must use this
 *                       wording verbatim; it is never paraphrased.
 *
 * This module keeps the YAML and the `claims` table in sync and offers a
 * read API for the assistant. The table is a cache of the YAML, not a second
 * source of truth: `syncClaimsFromYaml()` is idempotent and the YAML always
 * wins.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { parse } from "yaml";
import { z } from "zod";

import { query } from "./db";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** A row of the `claims` table. */
export interface ClaimRecord {
  id: string;
  topic: string;
  claim: string;
  status: string;
  evidence: string;
  source: string;
  /** The approved public wording. Use it verbatim. */
  publicWording: string;
  createdAt?: string;
  updatedAt?: string;
}

/** The shape of one entry in `content/claims.yaml`. */
export const ClaimFileSchema = z.object({
  id: z.string().min(1),
  topic: z.string().min(1),
  claim: z.string().min(1),
  status: z.enum(["verified", "partial", "unverified", "contradicted"]),
  evidence: z.string(),
  source: z.string().optional(),
  publicWording: z.string().min(1),
});

/** The statuses a claim can have. */
export const CLAIM_STATUSES = [
  "verified",
  "partial",
  "unverified",
  "contradicted",
] as const;

/* ------------------------------------------------------------------ */
/* YAML                                                                */
/* ------------------------------------------------------------------ */

/** Absolute path of the claim ledger. */
export const CLAIMS_YAML_PATH = path.join(
  process.cwd(),
  "content",
  "claims.yaml",
);

/**
 * Parse `content/claims.yaml`.
 *
 * The file is a top level LIST of claims. `evidence` and `source` may be
 * block scalars (`>` / `|`), which the `yaml` package resolves into folded
 * strings.
 */
export function readClaimsYaml(
  filePath: string = CLAIMS_YAML_PATH,
): Array<z.infer<typeof ClaimFileSchema>> {
  const raw = readFileSync(filePath, "utf8");
  const parsed = parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(
      `[retrieval] ${filePath} must contain a list of claims, got ${typeof parsed}`,
    );
  }
  return z.array(ClaimFileSchema).parse(parsed);
}

/* ------------------------------------------------------------------ */
/* Sync                                                                */
/* ------------------------------------------------------------------ */

const UPSERT_CLAIM_SQL = `
  INSERT INTO claims (id, topic, claim, status, evidence, source, public_wording, updated_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, now())
  ON CONFLICT (id) DO UPDATE SET
    topic          = EXCLUDED.topic,
    claim          = EXCLUDED.claim,
    status         = EXCLUDED.status,
    evidence       = EXCLUDED.evidence,
    source         = EXCLUDED.source,
    public_wording = EXCLUDED.public_wording,
    updated_at     = now()`;

/**
 * Upsert every claim from `content/claims.yaml` into the `claims` table.
 *
 * Idempotent: running it twice leaves the table in the same state.
 *
 * @returns the number of claims written
 */
export async function syncClaimsFromYaml(
  filePath: string = CLAIMS_YAML_PATH,
): Promise<number> {
  const claims = readClaimsYaml(filePath);
  for (const claim of claims) {
    await query(UPSERT_CLAIM_SQL, [
      claim.id,
      claim.topic,
      claim.claim,
      claim.status,
      claim.evidence,
      claim.source ?? "",
      claim.publicWording,
    ]);
  }
  return claims.length;
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

const CLAIM_COLUMNS = `
  id, topic, claim, status, evidence, source, public_wording, created_at, updated_at`;

const ALL_CLAIMS_SQL = `
  SELECT ${CLAIM_COLUMNS}
    FROM claims
   ORDER BY topic, id`;

const CLAIM_BY_ID_SQL = `
  SELECT ${CLAIM_COLUMNS}
    FROM claims
   WHERE id = $1
   LIMIT 1`;

const CLAIM_BY_TOPIC_SQL = `
  SELECT ${CLAIM_COLUMNS}
    FROM claims
   WHERE lower(topic) = lower($1)
   ORDER BY id
   LIMIT 1`;

function toClaimRecord(row: {
  id: string;
  topic: string;
  claim: string;
  status: string;
  evidence: string;
  source: string;
  public_wording: string;
  created_at?: Date | string;
  updated_at?: Date | string;
}): ClaimRecord {
  const iso = (value: Date | string | undefined): string | undefined => {
    if (!value) return undefined;
    return value instanceof Date ? value.toISOString() : String(value);
  };
  return {
    id: row.id,
    topic: row.topic,
    claim: row.claim,
    status: row.status,
    evidence: row.evidence ?? "",
    source: row.source ?? "",
    publicWording: row.public_wording ?? "",
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/**
 * Look up a claim by id, or by topic when no id matches.
 *
 * @param topicOrId the claim id (`smartapply-cost`) or the topic
 *                  (`SmartApply cost reduction`)
 */
export async function getClaim(
  topicOrId: string,
): Promise<ClaimRecord | null> {
  const needle = topicOrId.trim();
  if (!needle) return null;

  const byId = await query<Parameters<typeof toClaimRecord>[0]>(
    CLAIM_BY_ID_SQL,
    [needle],
  );
  if (byId.rows.length > 0) return toClaimRecord(byId.rows[0]);

  const byTopic = await query<Parameters<typeof toClaimRecord>[0]>(
    CLAIM_BY_TOPIC_SQL,
    [needle],
  );
  if (byTopic.rows.length > 0) return toClaimRecord(byTopic.rows[0]);

  return null;
}

/** Every claim in the ledger. */
export async function getAllClaims(): Promise<ClaimRecord[]> {
  const result = await query<Parameters<typeof toClaimRecord>[0]>(
    ALL_CLAIMS_SQL,
  );
  return result.rows.map(toClaimRecord);
}
