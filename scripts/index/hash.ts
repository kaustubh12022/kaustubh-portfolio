import { createHash } from "node:crypto";

/**
 * sha256 of the joined parts, truncated to 32 hex characters.
 *
 * Used both for chunk identity and for incremental re-indexing: when the
 * content of a chunk is unchanged the hash is unchanged, so the row can be
 * skipped instead of re-embedded.
 */
export function contentHash(parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part ?? "");
  }
  return hash.digest("hex").slice(0, 32);
}

/** The minimal shape `chunkKey` needs. */
export interface ChunkKeyInput {
  projectId: string;
  path: string;
  startLine: number;
  endLine: number;
  contentHash: string;
}

/**
 * Stable identity of a chunk: `${projectId}:${path}:${startLine}:${endLine}:${hash}`.
 */
export function chunkKey(chunk: ChunkKeyInput): string {
  return `${chunk.projectId}:${chunk.path}:${chunk.startLine}:${chunk.endLine}:${chunk.contentHash}`;
}
