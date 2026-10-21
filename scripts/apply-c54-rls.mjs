// Apply the tightened RLS policy set to the C54 Supabase project.
//
// The policy set lives in init_tables.js so it is version-controlled. This
// script applies the SAME policies to the live database, using the
// Management API's query endpoint.
//
// The Management API runs as the `postgres` role, which on this project is
// not a superuser (rolsuper = false) but DOES have BYPASSRLS, so it can
// create and drop policies.
//
// Usage:
//   node --env-file=.env.local scripts/apply-c54-rls.mjs

import { readFileSync } from "node:fs";
import path from "node:path";

const PAT = process.env.SUPABASE_ACCESS_TOKEN;
const REF = process.env.C54_PROJECT_REF ?? "ixczvfnzttmiecgqoiek";
const ENDPOINT = `https://api.supabase.com/v1/projects/${REF}/database/query`;

if (!PAT) {
  console.error("SUPABASE_ACCESS_TOKEN is not set.");
  process.exit(1);
}

/**
 * Extract the RLS block from init_tables.js.
 *
 * The script is the source of truth for the policy set, so it is read
 * rather than duplicated here. The block starts at the RLS marker and runs
 * to the end of the file.
 */
/**
 * Extract the RLS policy set from init_tables.js.
 *
 * The script is the source of truth for the policy set, so it is read
 * rather than duplicated here. The policy set is the run of
 * `await client.query(\`...\`)` blocks that start at the "RLS POLICY SET"
 * marker and end before the Realtime block.
 */
function readPolicyBlock() {
  const file = path.join(
    "C:\\Users\\kalek\\Desktop\\GitHub projects\\C54-Casino",
    "init_tables.js",
  );
  const source = readFileSync(file, "utf8");

  const startMarker = source.indexOf("RLS POLICY SET");
  if (startMarker === -1) {
    throw new Error("Could not find the RLS POLICY SET marker in init_tables.js");
  }
  const endMarker = source.indexOf("Enable Realtime", startMarker);
  if (endMarker === -1) {
    throw new Error("Could not find the Realtime marker in init_tables.js");
  }

  const region = source.slice(startMarker, endMarker);

  // Every `await client.query(\` ... \`);` block in the region is SQL.
  const statements = [];
  const pattern = /await client\.query\(`([\s\S]*?)`\);/g;
  let match;
  while ((match = pattern.exec(region)) !== null) {
    statements.push(match[1]);
  }

  if (statements.length === 0) {
    throw new Error("No SQL statements found in the RLS region");
  }

  return statements.join("\n");
}

async function runSql(sql, label) {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PAT}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: sql }),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${label} failed (${response.status}): ${body}`);
  }
  return body;
}

console.log(`Applying the RLS policy set to ${REF}...\n`);

// 1. Show what is there now.
const before = await runSql(
  `select tablename, policyname, cmd, qual, with_check
     from pg_policies
    where schemaname = 'public'
      and tablename in ('teen_patti_games','rummy_games','players','live_sessions','settlement_ledger','settle_ups')
    order by tablename, policyname`,
  "read current policies",
);
const beforeRows = JSON.parse(before);
console.log(`BEFORE: ${beforeRows.length} policies`);
for (const row of beforeRows) {
  console.log(`  ${row.tablename}.${row.policyname} [${row.cmd}]`);
}

// 2. Apply the new set.
const block = readPolicyBlock();
console.log(`\nApplying ${block.length} characters of policy SQL...\n`);
await runSql(block, "apply policies");

// 3. Verify.
const after = await runSql(
  `select tablename, policyname, cmd
     from pg_policies
    where schemaname = 'public'
      and tablename in ('teen_patti_games','rummy_games','players','live_sessions','settlement_ledger','settle_ups')
    order by tablename, policyname`,
  "verify policies",
);
const afterRows = JSON.parse(after);
console.log(`AFTER: ${afterRows.length} policies`);
for (const row of afterRows) {
  console.log(`  ${row.tablename}.${row.policyname} [${row.cmd}]`);
}

// 4. Confirm no anonymous DELETE was actually GRANTED.
//
//    The policy names read "Deny anon delete ..." and "Allow anon delete ...",
//    so the name alone cannot decide this. The `qual` and `with_check` clauses
//    can: a grant is `USING (true)`, a deny is `USING (false)`.
const deletePolicies = await runSql(
  `select tablename, policyname, qual
     from pg_policies
    where schemaname = 'public'
      and cmd = 'DELETE'
      and tablename in ('teen_patti_games','rummy_games','players','live_sessions','settlement_ledger','settle_ups')
    order by tablename, policyname`,
  "read the delete policies",
);
const deleteRows = JSON.parse(deletePolicies);
const granted = deleteRows.filter(
  (row) => String(row.qual ?? "").replace(/\s/g, "") === "true",
);
const denied = deleteRows.filter(
  (row) => String(row.qual ?? "").replace(/\s/g, "") === "false",
);

console.log(`\nanonymous DELETE policies: ${deleteRows.length}`);
for (const row of deleteRows) {
  console.log(`  ${row.tablename}.${row.policyname} qual=${row.qual}`);
}
console.log(
  `  granted: ${granted.length} (must be 0)   denied: ${denied.length}`,
);
console.log(granted.length === 0 ? "  CORRECT" : "  PROBLEM - a delete is still granted");
