"""The golden set, loaded from the SAME file the TypeScript benchmark uses.

This is a port of `lib/eval/golden.ts`. Only two functions matter for the
comparison:

  * `read_golden_set()` - parse `evals/golden-set.yaml`;
  * `scorable_questions()` - keep the questions that name the source files
    that answer them.

The scorable filter is the important one. A question is scorable when
`expect.evidence` is non-empty, because a question answered from the
content layer (metrics, claim corrections, refusals) has no code target to
retrieve. 79 of the 150 questions are scorable, and BOTH implementations
score the same 79.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from .config import GOLDEN_SET_PATH


@dataclass(frozen=True)
class Evidence:
    """One expected citation: the file, and often the line range."""

    path: str
    start_line: int | None = None
    end_line: int | None = None
    symbol: str | None = None
    project: str | None = None


@dataclass(frozen=True)
class Question:
    """One golden-set question."""

    id: str
    bucket: str
    question: str
    project: str | None
    evidence: tuple[Evidence, ...] = field(default_factory=tuple)


def _as_evidence(raw: list[dict[str, Any]]) -> tuple[Evidence, ...]:
    return tuple(
        Evidence(
            path=item["path"],
            start_line=item.get("startLine"),
            end_line=item.get("endLine"),
            symbol=item.get("symbol"),
            project=item.get("project"),
        )
        for item in raw
    )


def read_golden_set(path: Path = GOLDEN_SET_PATH) -> list[Question]:
    """Parse the golden set YAML.

    @param path the file to read. Defaults to `evals/golden-set.yaml`.
    @raises when the YAML does not have the expected shape.
    """
    raw = yaml.safe_load(path.read_text(encoding="utf8"))
    if not isinstance(raw, list):
        raise ValueError(f"[lab] {path} must contain a list of questions")

    questions: list[Question] = []
    for item in raw:
        expect = item.get("expect") or {}
        questions.append(
            Question(
                id=item["id"],
                bucket=item["bucket"],
                question=item["question"],
                project=item.get("project"),
                evidence=_as_evidence(expect.get("evidence") or []),
            )
        )
    return questions


def scorable_questions(questions: list[Question]) -> list[Question]:
    """The questions the retrieval benchmark scores.

    A question is scorable when it names the source files that answer it.
    """
    return [question for question in questions if question.evidence]
