/**
 * Contextual header builder.
 *
 * Every chunk is embedded and searched as `header + "\n" + content`. The
 * header carries the repository, file, symbol, kind, line range and the
 * top-level imports of the enclosing file so that a bare snippet is still
 * self-describing when it is retrieved.
 */

export interface HeaderInput {
  /** Repository folder name, e.g. `JobHunt-Automation`. */
  repoName: string;
  /** Commit SHA (shortened to 7 characters in the header). */
  repoSha: string;
  /** Repo-relative POSIX path. */
  path: string;
  /** Best-effort symbol name (may be empty). */
  symbol: string;
  /** Chunk kind. */
  kind: string;
  /** 1-indexed inclusive line range. */
  startLine: number;
  /** 1-indexed inclusive line range. */
  endLine: number;
  /** Top-level imports of the enclosing file. */
  imports: string[];
}

/** Maximum number of import names kept in the header. */
export const MAX_IMPORTS = 8;

/**
 * Build the contextual header.
 *
 * ```
 * repo: JobHunt-Automation @ d3aebf7
 * file: src/ai_engine.py
 * symbol: calculate_deepseek_cost
 * kind: function
 * lines: 59-74
 * imports: openai, dataclasses
 * ```
 */
export function buildHeader(input: HeaderInput): string {
  const shortSha = (input.repoSha ?? "").slice(0, 7);
  const imports = (input.imports ?? []).slice(0, MAX_IMPORTS).join(", ");
  return [
    `repo: ${input.repoName} @ ${shortSha}`,
    `file: ${input.path}`,
    `symbol: ${input.symbol && input.symbol.length > 0 ? input.symbol : "(none)"}`,
    `kind: ${input.kind}`,
    `lines: ${input.startLine}-${input.endLine}`,
    `imports: ${imports}`,
  ].join("\n");
}

/** Remove surrounding quotes from an import specifier. */
function stripQuotes(value: string): string {
  return value.replace(/^['"`]|['"`]$/g, "");
}

/** Regex fallback import extraction, used when no AST is available. */
export function regexImports(source: string, language: string): string[] {
  const names: string[] = [];
  if (language === "python") {
    const plain = /^[ \t]*import[ \t]+([A-Za-z_][\w.]*)/gm;
    const from = /^[ \t]*from[ \t]+([A-Za-z_][\w.]*)[ \t]+import/gm;
    let m: RegExpExecArray | null;
    while ((m = plain.exec(source)) !== null) names.push(m[1].split(".")[0]);
    while ((m = from.exec(source)) !== null) names.push(m[1].split(".")[0]);
  } else if (language === "javascript" || language === "typescript" || language === "tsx") {
    const re = /^[ \t]*import[ \t]+(?:[^'"]*?from[ \t]*)?['"]([^'"]+)['"]/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) names.push(m[1]);
  } else if (language === "dart") {
    const re = /^[ \t]*import[ \t]+['"]([^'"]+)['"]/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) names.push(m[1]);
  }
  return names;
}

/** Minimal structural view of a tree-sitter node (avoids a hard dependency on the package typings). */
export interface ImportNode {
  type: string;
  text: string;
  namedChildCount: number;
  namedChild(index: number): ImportNode | null;
  childForFieldName(field: string): ImportNode | null;
}

/** Minimal structural view of a tree-sitter tree. */
export interface ImportTree {
  rootNode: ImportNode;
}

/**
 * Extract the top-level imports of a file.
 *
 * Uses the AST when one is supplied, otherwise falls back to a regex scan.
 * At most {@link MAX_IMPORTS} names are returned.
 */
export function extractImports(
  source: string,
  language: string,
  tree?: ImportTree | null,
): string[] {
  const names: string[] = [];

  const root = tree?.rootNode;
  if (root) {
    for (let i = 0; i < root.namedChildCount; i++) {
      const child = root.namedChild(i);
      if (!child) continue;
      if (language === "python") {
        if (child.type === "import_statement") {
          for (let j = 0; j < child.namedChildCount; j++) {
            const part = child.namedChild(j);
            if (!part) continue;
            if (part.type === "dotted_name") {
              names.push(part.text.split(".")[0]);
            } else if (part.type === "aliased_import") {
              const dotted = part.namedChild(0);
              if (dotted && dotted.type === "dotted_name") {
                names.push(dotted.text.split(".")[0]);
              }
            }
          }
        } else if (child.type === "import_from_statement") {
          const moduleName = child.childForFieldName("module_name");
          if (moduleName) names.push(moduleName.text.split(".")[0]);
        }
      } else if (
        language === "javascript" ||
        language === "typescript" ||
        language === "tsx"
      ) {
        if (child.type === "import_statement") {
          const sourceNode = child.childForFieldName("source");
          if (sourceNode) names.push(stripQuotes(sourceNode.text));
        }
      } else if (language === "dart") {
        if (child.type === "import_specification") {
          const uri = child.childForFieldName("uri");
          if (uri) names.push(stripQuotes(uri.text));
        }
      }
    }
  }

  if (names.length === 0) {
    names.push(...regexImports(source, language));
  }

  const unique: string[] = [];
  for (const name of names) {
    if (name && !unique.includes(name)) unique.push(name);
  }
  return unique.slice(0, MAX_IMPORTS);
}
