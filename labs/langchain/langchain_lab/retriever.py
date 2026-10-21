"""The retrieval chain, in LangChain's own vocabulary.

THE COMPOSITION
---------------
    MultiQueryRetriever            <- query expansion (optional)
      |
      +-- HybridRetriever          <- vector leg + keyword leg + RRF
            |
            +-- CrossEncoderReranker  <- re-orders the top 20

Every box is a real LangChain class:

  * `HybridRetriever` is a `BaseRetriever` - the interface every LangChain
    retriever implements;
  * `MultiQueryRetriever` is LangChain's own query-expansion retriever;
  * `CrossEncoderReranker` is LangChain's own document compressor.

Only `HybridRetriever` is hand-written, because LangChain has no
equivalent of a hybrid ANN + BM25 + trigram + substring retriever with
Reciprocal Rank Fusion.

THE EXPANDER IS NOT AN LLM
--------------------------
`MultiQueryRetriever` normally asks an LLM to write three paraphrases of
the question. That would cost money (about $0.001 per question) and it
would make the comparison unrepeatable, because a sampled paraphrase is a
different paraphrase every run. The lab therefore plugs in a
DETERMINISTIC expander: the same synonym and identifier-splitting rules
the TypeScript pipeline uses by hand. It is the same interface, the same
prompt and the same retriever - only the model behind it is replaced by a
function.

That is a real limitation and it is stated in the write-up: this measures
the FRAMEWORK, not the paraphrases an LLM would have produced.
"""

from __future__ import annotations

import re
from typing import Any, Literal

from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.documents import Document
from langchain_core.language_models.llms import LLM
from langchain_core.outputs import Generation, LLMResult
from langchain_core.retrievers import BaseRetriever
from pydantic import ConfigDict

from .cross_encoder import OnnxCrossEncoder
from .store import Chunk, NeonStore, Tuning, expansion_terms, fuse_rrf

#: The synonyms the TypeScript pipeline uses by hand. Copied so the two
#: implementations expand the same words.
SYNONYMS: dict[str, tuple[str, ...]] = {
    "job": ("posting", "jobs"),
    "jobs": ("posting", "postings"),
    "auth": ("jwt", "login"),
    "score": ("rank", "relevance"),
    "settle": ("transfer", "settlement"),
    "booking": ("reservation",),
    "camping": ("campground", "site"),
    "casino": ("game", "wallet"),
    "resume": ("cv",),
    "cover": ("letter",),
    "scrape": ("crawl", "fetch"),
    "embed": ("vector", "embedding"),
    "similarity": ("distance", "score"),
    "deploy": ("hosting", "release"),
    "test": ("spec", "assert"),
}


class HybridRetriever(BaseRetriever):
    """A LangChain retriever over the TypeScript pipeline's hybrid search.

    The retriever returns the FUSED candidate pool (the top 20 by default),
    not the final answer: the cross-encoder is the second stage and it has
    to see more than the final five.
    """

    model_config = ConfigDict(arbitrary_types_allowed=True)

    store: NeonStore
    embedding_model: Any
    project_id: str | None = None
    tuning: Tuning = Tuning()

    def _get_relevant_documents(
        self, query: str, *, run_manager: Any = None
    ) -> list[Document]:
        """Return the fused candidate pool for `query`, best first.

        The pool is NOT the answer: it is what the cross-encoder re-orders.
        The caller slices it to `rerank_depth` before compressing, exactly
        like `applyReranker` does in `lib/retrieval/search.ts`.
        """
        embedding = self.embedding_model.embed_query(query)
        pool = self.store.hybrid_search(
            query, embedding, self.project_id, self.tuning
        )

        if self.tuning.prf and pool:
            pool = self._expand(query, pool)

        return [to_document(chunk, score) for chunk, score in pool]

    def _expand(
        self, query: str, pool: list[tuple[Chunk, float]]
    ) -> list[tuple[Chunk, float]]:
        """Pseudo-relevance feedback, the way `lib/retrieval/search.ts` does it.

        Take the identifiers of the best candidates, search for them again,
        and fuse the two keyword rankings. This is the hand-rolled
        equivalent of what `MultiQueryRetriever` does with an LLM.
        """
        from .store import expansion_terms, path_exclusion

        chunks = [chunk for chunk, _score in pool]
        terms = expansion_terms(chunks, self.tuning.prf_top_k)
        if not terms:
            return pool

        exclude_path = path_exclusion(query, self.tuning.exclude_tests)

        expanded = self.store.keyword_leg(
            f"{query} {' '.join(terms)}",
            self.project_id,
            self.tuning.candidates,
            exclude_path,
            self.tuning,
        )
        if not expanded:
            return pool

        by_id = {chunk.id: chunk for chunk, _score in pool}
        for chunk in expanded:
            by_id.setdefault(chunk.id, chunk)

        vector_ids = [chunk.id for chunk, _score in pool]
        keyword_ids = [chunk.id for chunk, _score in pool] + [
            chunk.id for chunk in expanded
        ]
        fused = fuse_rrf(
            [
                ("vector", vector_ids, self.tuning.vector_weight),
                ("keyword", keyword_ids, self.tuning.keyword_weight),
            ]
        )
        return [(by_id[chunk_id], score) for chunk_id, score in fused if chunk_id in by_id]


class DeterministicQueryExpander(LLM):
    """A stand-in for the LLM `MultiQueryRetriever` normally uses.

    It answers the default "generate 3 alternative queries" prompt with
    three lines:

      1. the question as it was asked;
      2. the question plus the fragments of the identifiers it contains
         (`SmartApply` -> `smart`, `apply`);
      3. the question plus the synonyms of the words it contains
         (`jobs` -> `postings`).

    It costs nothing, it is deterministic, and it uses the same vocabulary
    rules the TypeScript pipeline uses.
    """

    @property
    def _llm_type(self) -> str:
        """The provider name, as LangChain reports it in the run traces."""
        return "deterministic-code-expander"

    def _call(
        self,
        prompt: str,
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> str:
        """Answer the MultiQueryRetriever prompt with three alternative queries."""
        question = extract_question(prompt)
        return "\n".join(expansion_queries(question))


def extract_question(prompt: str) -> str:
    """Pull the original question out of the MultiQueryRetriever prompt."""
    match = re.search(r"Original question:\s*(.+)\s*$", prompt, re.DOTALL)
    if match:
        return match.group(1).strip()
    return prompt.strip()


def expansion_queries(question: str) -> list[str]:
    """The three deterministic alternative queries for `question`."""
    fragments = identifier_fragments(question)
    synonyms = synonym_terms(question)
    queries = [question]
    if fragments:
        queries.append(f"{question} {' '.join(fragments)}")
    if synonyms:
        queries.append(f"{question} {' '.join(synonyms)}")
    return queries


def identifier_fragments(question: str) -> list[str]:
    """The word-parts of every camelCase / snake_case identifier in the question."""
    out: list[str] = []
    for token in re.findall(r"[A-Za-z0-9_]+", question):
        if "_" not in token and not re.search(r"[a-z][A-Z]", token):
            continue
        for part in re.split(r"[^A-Za-z0-9]+", re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", token)):
            part = part.lower()
            if len(part) >= 3 and part not in out:
                out.append(part)
    return out


def synonym_terms(question: str) -> list[str]:
    """The synonyms of the words the question uses."""
    out: list[str] = []
    for token in re.findall(r"[A-Za-z0-9_]+", question.lower()):
        for synonym in SYNONYMS.get(token, ()):  # noqa: SIM118
            if synonym not in out:
                out.append(synonym)
    return out


def to_document(chunk: Chunk, score: float) -> Document:
    """Turn a chunk into a LangChain `Document`.

    `page_content` is `header + content`, because that is the text the
    TypeScript cross-encoder reads (`lib/retrieval/search.ts` builds
    `${hit.header}\\n${hit.content}`). If the two read different text, the
    rerank stage is not comparable.
    """
    return Document(
        id=chunk.id,
        page_content=f"{chunk.header}\n{chunk.content}",
        metadata={
            "project_id": chunk.project_id,
            "path": chunk.path,
            "start_line": chunk.start_line,
            "end_line": chunk.end_line,
            "symbol": chunk.symbol,
            "kind": chunk.kind,
            "lang": chunk.lang,
            "header": chunk.header,
            "content": chunk.content,
            "score": score,
        },
    )


def build_compressor(
    top_n: int = 10, model: OnnxCrossEncoder | None = None
) -> Any:
    """LangChain's own `CrossEncoderReranker`, over the bundled ONNX weights."""
    from langchain_classic.retrievers.document_compressors.cross_encoder_rerank import (
        CrossEncoderReranker,
    )

    return CrossEncoderReranker(model=model or OnnxCrossEncoder(), top_n=top_n)


def build_multi_query_retriever(retriever: BaseRetriever) -> Any:
    """LangChain's own `MultiQueryRetriever`, over the deterministic expander."""
    from langchain_classic.retrievers.multi_query import (
        DEFAULT_QUERY_PROMPT,
        MultiQueryRetriever,
    )

    return MultiQueryRetriever.from_llm(
        retriever=retriever,
        llm=DeterministicQueryExpander(),
        prompt=DEFAULT_QUERY_PROMPT,
        include_original=False,
    )
