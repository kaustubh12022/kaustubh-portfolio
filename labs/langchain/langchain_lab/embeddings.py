"""The embedding model: the SAME bundled ONNX weights the app ships.

THE POINT
---------
The corpus in Neon was embedded by the TypeScript pipeline with
`Xenova/all-MiniLM-L6-v2` at q8. A query embedded with a DIFFERENT model
(or a different quantisation) lands in a different part of the vector
space and every distance is noise. So the lab does not download anything:
it loads `models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx` and
runs it with `onnxruntime`.

That keeps the comparison honest in two ways:

  * the vectors are the same kind of vector, so the retrieval numbers are
    comparable;
  * the embedding cost is measured on the same weights, so the latency
    numbers are comparable too.

`onnxruntime` (native) is used here where the app uses the ONNX Runtime
WASM backend, because the app has to run on a serverless host where the
native binary cannot be traced into the bundle. On a normal machine the
native runtime is the faster of the two, and the comparison in
`docs/LANGCHAIN_COMPARISON.md` says so explicitly.

POOLING
-------
`@huggingface/transformers` is called with `{pooling: "mean",
normalize: true}` in `lib/retrieval/embed.ts`. That is exactly what this
module does: attention-masked mean pooling, then L2 normalisation.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import numpy as np
import onnxruntime as ort
from langchain_core.embeddings import Embeddings
from tokenizers import Tokenizer

from .config import EMBEDDING_MODEL_DIR

#: The dimensionality of the model. Matches `chunks.embedding vector(384)`.
EMBEDDING_DIM = 384

#: The model's maximum sequence length.
MAX_TOKENS = 512


class LocalMiniLM:
    """A minimal, dependency-light wrapper around the bundled MiniLM ONNX file."""

    def __init__(self, model_dir: Path = EMBEDDING_MODEL_DIR) -> None:
        self.model_dir = model_dir
        onnx_path = model_dir / "onnx" / "model_quantized.onnx"
        tokenizer_path = model_dir / "tokenizer.json"

        if not onnx_path.exists():
            raise FileNotFoundError(
                f"[lab] the bundled embedding model is missing: {onnx_path}. "
                f"It ships with the repository; the lab never downloads it."
            )

        # `intra_op_num_threads` is left at the default because the lab is a
        # single-user benchmark, not a server.
        self.session = ort.InferenceSession(
            str(onnx_path), providers=["CPUExecutionProvider"]
        )
        self.input_names = {item.name for item in self.session.get_inputs()}

        self.tokenizer = Tokenizer.from_file(str(tokenizer_path))
        self.tokenizer.enable_truncation(max_length=MAX_TOKENS)
        self.tokenizer.enable_padding()

    # ------------------------------------------------------------------
    # Forward pass
    # ------------------------------------------------------------------

    def encode(self, texts: list[str]) -> np.ndarray:
        """Embed a batch of texts.

        @param texts the texts to embed.
        @return an array of shape `(len(texts), 384)`, L2-normalised.
        """
        if not texts:
            return np.zeros((0, EMBEDDING_DIM), dtype=np.float32)

        encodings = self.tokenizer.encode_batch(texts)
        input_ids = np.array([enc.ids for enc in encodings], dtype=np.int64)
        attention_mask = np.array([enc.attention_mask for enc in encodings], dtype=np.int64)

        feed: dict[str, Any] = {
            "input_ids": input_ids,
            "attention_mask": attention_mask,
        }
        if "token_type_ids" in self.input_names:
            feed["token_type_ids"] = np.array(
                [enc.type_ids for enc in encodings], dtype=np.int64
            )

        output = self.session.run(None, feed)[0]  # (batch, seq, 384)

        # Attention-masked mean pooling.
        mask = attention_mask.astype(np.float32)[..., None]
        summed = (output * mask).sum(axis=1)
        counts = np.clip(mask.sum(axis=1), 1e-9, None)
        pooled = summed / counts

        # L2 normalisation, so a cosine distance is a dot product.
        norms = np.linalg.norm(pooled, axis=1, keepdims=True)
        pooled = pooled / np.clip(norms, 1e-12, None)
        return pooled.astype(np.float32)

    def embed_query(self, text: str) -> np.ndarray:
        """Embed one query string."""
        return self.encode([text])[0]

    def embed_documents(self, texts: list[str]) -> list[np.ndarray]:
        """Embed a batch of documents."""
        if not texts:
            return []
        return [row for row in self.encode(texts)]


class LocalOnnxEmbeddings(Embeddings):
    """A LangChain `Embeddings` implementation over the bundled ONNX model.

    LangChain's `PGVector` store insists on an `Embeddings` object. This
    adapter exists so the LangChain vector store can be pointed at the
    corpus without downloading a second copy of the model.

    The adapter is deliberately thin: it adds no normalisation, no
    truncation and no caching of its own, because the model class already
    does exactly what the TypeScript pipeline does.
    """

    def __init__(self, model: LocalMiniLM | None = None) -> None:
        self._model = model or LocalMiniLM()

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        """Embed a batch of documents."""
        rows = self._model.encode(texts)
        return [[float(value) for value in row] for row in rows]

    def embed_query(self, text: str) -> list[float]:
        """Embed one query string."""
        row = self._model.embed_query(text)
        return [float(value) for value in row]


def to_vector_literal(vector: np.ndarray) -> str:
    """Render a vector as a pgvector literal: `[0.1,0.2,...]`.

    The `chunks.embedding` column is `vector(384)`, so the literal has to
    carry exactly 384 numbers.
    """
    return "[" + ",".join(repr(float(value)) for value in vector) + "]"


def cold_start_seconds(model_dir: Path = EMBEDDING_MODEL_DIR) -> float:
    """How long it takes to go from "process started" to "first vector".

    This is the number that decides whether a serverless cold start is
    acceptable, so it is measured rather than estimated.
    """
    started = time.perf_counter()
    model = LocalMiniLM(model_dir)
    model.embed_query("cold start probe")
    return time.perf_counter() - started
