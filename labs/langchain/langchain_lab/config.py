"""Configuration for the LangChain side-lab.

The lab is a COMPARISON artifact, not a second implementation of the
product. It therefore points at the same things the TypeScript pipeline
points at:

  * the same Neon database (`chunks` table, same rows);
  * the same golden set (`evals/golden-set.yaml`);
  * the same model weights (`models/Xenova/...`, the ONNX files that ship
    with the repository).

Nothing here is imported by the application. The `labs/` tree is a side-lab
and is not part of the deployed bundle.
"""

from __future__ import annotations

import os
from pathlib import Path

# --------------------------------------------------------------------------
# Paths
# --------------------------------------------------------------------------

# `labs/langchain/langchain_lab/config.py` -> `langchain_lab` (0) ->
# `langchain` (1) -> `labs` (2) -> the repository root (3).
REPO_ROOT = Path(__file__).resolve().parents[3]

#: The env file the Next.js app and the evaluation CLIs read.
ENV_FILE = REPO_ROOT / ".env.local"

#: The labelled question set. The lab reads the SAME file the TypeScript
#: benchmark reads, so "the same 79 scorable questions" is not an analogy.
GOLDEN_SET_PATH = REPO_ROOT / "evals" / "golden-set.yaml"

#: The bundled ONNX weights. The lab loads the SAME files the TypeScript
#: pipeline loads, so the two implementations embed into the same vector
#: space and the same corpus.
MODELS_DIR = REPO_ROOT / "models"

#: `Xenova/all-MiniLM-L6-v2`, q8 ONNX, 384 dimensions.
EMBEDDING_MODEL_DIR = MODELS_DIR / "Xenova" / "all-MiniLM-L6-v2"

#: `Xenova/ms-marco-MiniLM-L-6-v2`, q8 ONNX, cross-encoder.
RERANKER_MODEL_DIR = MODELS_DIR / "Xenova" / "ms-marco-MiniLM-L-6-v2"

#: The schema the lab owns inside the shared database.
#:
#: The lab must not write to `public`: the production pipeline owns those
#: tables. Everything the lab creates (the LangChain collection tables, the
#: read-only view) lives in this schema and can be dropped with
#: `DROP SCHEMA langchain_lab CASCADE`.
LAB_SCHEMA = "langchain_lab"

# --------------------------------------------------------------------------
# Environment
# --------------------------------------------------------------------------

#: The variables the lab needs. `DATABASE_URL` is the POOLED endpoint,
#: `DATABASE_URL_UNPOOLED` is the DIRECT one - the vector leg needs the
#: direct endpoint because Lakebase's `lakebase_ann` access method cannot
#: be used through the Neon pooler.
REQUIRED_ENV = ("DATABASE_URL", "DATABASE_URL_UNPOOLED")


def load_env(keys: tuple[str, ...] = REQUIRED_ENV) -> None:
    """Copy `KEY=VALUE` pairs out of `.env.local` into `os.environ`.

    Mirrors `scripts/eval/env.ts`: an environment variable that is already
    set WINS, so a CI run can point the lab at a different database.

    Nothing is printed. The loader only copies values.
    """
    try:
        raw = ENV_FILE.read_text(encoding="utf8")
    except OSError:
        return  # no .env.local: the environment has to provide the values

    for line in raw.splitlines():
        trimmed = line.strip()
        if not trimmed or trimmed.startswith("#"):
            continue
        eq = trimmed.find("=")
        if eq == -1:
            continue
        key = trimmed[:eq].strip()
        value = trimmed[eq + 1 :].strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key not in keys or os.environ.get(key):
            continue
        os.environ[key] = value


def _require(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(
            f"[lab] {name} is not set. Copy it from {ENV_FILE} or export it "
            f"before running the lab. The lab never talks to any database "
            f"other than the one this variable points at."
        )
    return value


def database_url() -> str:
    """The POOLED Neon connection string (keyword legs, metadata queries)."""
    load_env()
    return _require("DATABASE_URL")


def database_url_direct() -> str:
    """The DIRECT Neon connection string (the ANN / vector leg).

    `lakebase_ann` fails through the pooler with
    `XX000 usage: need 0 probes, but 1 probes provided`, so the vector
    query has to run on the unpooled endpoint. The TypeScript pipeline
    keeps two pools for exactly this reason (`lib/retrieval/db.ts`).
    """
    load_env()
    return _require("DATABASE_URL_UNPOOLED")
