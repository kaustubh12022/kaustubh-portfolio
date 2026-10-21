import "server-only";

/**
 * The captured data models.
 *
 * WHY A SEPARATE CONTENT FOLDER
 * -----------------------------
 * `content/architecture/*.json` holds the hand-reviewed diagrams. The data
 * models are different: they are EXTRACTED from the schema files in the
 * indexed repositories by `scripts/index/datamodel.ts`, so they can be
 * regenerated and never drift from the code. They live in their own folder
 * because their provenance is different - one file per project, each one
 * listing the source files it was extracted from.
 *
 * WHY THE SERVER IS THE ONLY WRITER
 * ---------------------------------
 * The `data-model` visual shows tables and fields. A model that was allowed
 * to write them could invent a table that does not exist, which is exactly
 * the kind of claim this portfolio refuses to make. So the entities are read
 * from here, on the server, and the model only ever names the project.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import type { DataModelDocument, DataModelEntity } from "@/lib/types/chat";

const DATAMODEL_ROOT = join(process.cwd(), "content", "datamodel");

/**
 * The Zod mirror of `DataModelEntity` in `lib/types/chat.ts`.
 *
 * The generated file is data, so it is validated on the way in: a file that
 * was hand-edited into an invalid shape is rejected rather than rendered.
 */
export const DataModelEntitySchema = z.object({
  name: z.string().min(1),
  fields: z.array(
    z.object({
      name: z.string().min(1),
      type: z.string().min(1),
      required: z.boolean().optional(),
      relation: z.string().min(1).optional(),
    }),
  ),
  relations: z
    .array(
      z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        label: z.string().min(1),
        kind: z.enum(["1-1", "1-n", "n-n"]).optional(),
      }),
    )
    .optional(),
});

/** The Zod mirror of `DataModelDocument` in `lib/types/chat.ts`. */
export const DataModelDocumentSchema = z.object({
  project: z.string().min(1),
  generatedBy: z.string().min(1),
  source: z.string().min(1),
  entities: z.array(DataModelEntitySchema),
});

/**
 * The documents already read, keyed by project id.
 *
 * A plain `Map` rather than React's `cache()`: this module is read from the
 * API route as well as from the React tree, and the file is a few kilobytes
 * that never changes while the process is alive.
 */
const documentCache = new Map<string, DataModelDocument | null>();

/**
 * Read the captured data model of one project.
 *
 * @param projectId the project id, e.g. `"pawna"`
 * @returns the document, or `null` when the project has no captured model
 */
export function getDataModelDocument(
  projectId: string,
): DataModelDocument | null {
  if (documentCache.has(projectId)) {
    return documentCache.get(projectId) ?? null;
  }

  let document: DataModelDocument | null = null;
  try {
    const raw = readFileSync(
      join(DATAMODEL_ROOT, `${projectId}.json`),
      "utf8",
    );
    document = DataModelDocumentSchema.parse(JSON.parse(raw));
  } catch {
    // No file for this project, or a file that does not validate. Either
    // way there is nothing honest to draw, and the caller shows an empty
    // frame instead of inventing tables.
    document = null;
  }

  documentCache.set(projectId, document);
  return document;
}

/**
 * The captured entities of one project.
 *
 * @param projectId the project id, e.g. `"pawna"`
 * @returns the entities, or an empty array when nothing was captured
 */
export function getDataModelEntities(projectId: string): DataModelEntity[] {
  return getDataModelDocument(projectId)?.entities ?? [];
}
