"""The LangChain side-lab.

A measured comparison between the TypeScript retrieval pipeline that the
portfolio ships and a LangChain implementation of the same task, run
against the same Neon database, the same golden set and the same model
weights.

Run it with:

    python -m langchain_lab.bench --mode production

See `labs/langchain/README.md`.
"""

from __future__ import annotations

__all__ = ["config", "cross_encoder", "embeddings", "golden", "metrics", "retriever", "store"]
