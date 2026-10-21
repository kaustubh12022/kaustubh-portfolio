"""The cross-encoder reranker, loaded from the SAME bundled ONNX weights.

The app's reranker is `Xenova/ms-marco-MiniLM-L-6-v2` (q8 ONNX, 23 MB),
run by `lib/retrieval/rerank.ts` through `@huggingface/transformers`. The
lab loads the same file through `onnxruntime`.

WHY A CUSTOM `BaseCrossEncoder` AND NOT `HuggingFaceCrossEncoder`
-----------------------------------------------------------------
LangChain ships `langchain_community.cross_encoders.HuggingFaceCrossEncoder`,
and it is the obvious choice. It also drags in `sentence-transformers`,
which drags in PyTorch: roughly 2.5 GB of wheels for a 23 MB model that
the repository ALREADY ships in ONNX form. The adapter below implements
the same one-method interface (`score(pairs) -> list[float]`) on top of
`onnxruntime`, so the real `CrossEncoderReranker` accepts it unchanged.

That is the point of the exercise: LangChain's interfaces are small
enough to implement yourself, which is a strength when the model is
already on disk in a format the framework cannot use.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import numpy as np
import onnxruntime as ort
from langchain_core.cross_encoders import BaseCrossEncoder
from tokenizers import Tokenizer

from .config import RERANKER_MODEL_DIR

#: How many characters of a chunk the cross-encoder reads.
#:
#: The model has a 512-token window and the query takes some of it, so the
#: document side has to be clipped. 900 characters is roughly 200 tokens.
#: The value is copied from `lib/retrieval/rerank.ts` so the two
#: implementations see the same text.
RERANK_MAX_CHARS = 900

#: The model's maximum sequence length.
MAX_TOKENS = 512


class OnnxCrossEncoder(BaseCrossEncoder):
    """A LangChain cross-encoder over the bundled `ms-marco` ONNX file."""

    def __init__(self, model_dir: Path = RERANKER_MODEL_DIR) -> None:
        onnx_path = model_dir / "onnx" / "model_quantized.onnx"
        tokenizer_path = model_dir / "tokenizer.json"

        if not onnx_path.exists():
            raise FileNotFoundError(
                f"[lab] the bundled reranker is missing: {onnx_path}. "
                f"It ships with the repository; the lab never downloads it."
            )

        self.session = ort.InferenceSession(
            str(onnx_path), providers=["CPUExecutionProvider"]
        )
        self.input_names = {item.name for item in self.session.get_inputs()}

        self.tokenizer = Tokenizer.from_file(str(tokenizer_path))
        self.tokenizer.enable_truncation(max_length=MAX_TOKENS)
        self.tokenizer.enable_padding()

        #: The scores of the most recent `score()` call.
        #:
        #: `CrossEncoderReranker` calls `score()` exactly once per
        #: compression and then sorts, so the scores can be zipped back onto
        #: the documents it returns. The class does not do that itself.
        self.last_scores: list[float] = []

    def score(self, text_pairs: list[tuple[str, str]]) -> list[float]:
        """Score (query, document) pairs. Higher is more relevant.

        @param text_pairs the pairs to score.
        @return one logit per pair.
        """
        if not text_pairs:
            self.last_scores = []
            return []

        left = [pair[0] for pair in text_pairs]
        right = [pair[1][:RERANK_MAX_CHARS] for pair in text_pairs]

        # `tokenizers` takes a list of (sequence, pair) tuples for batched
        # pair encoding.
        encodings = self.tokenizer.encode_batch(list(zip(left, right)))
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

        logits = self.session.run(None, feed)[0]  # (batch, 1) for ms-marco
        labels = logits.shape[-1]
        flat = logits.reshape(len(text_pairs), labels)

        scores: list[float] = []
        for row in flat:
            if labels == 1:
                # `ms-marco` cross-encoders are trained with a SINGLE
                # regression label: one logit per pair, higher is better.
                scores.append(float(row[0]))
            else:
                # A two-logit head (relevant / not relevant) is scored by
                # the margin.
                scores.append(float(row[0]) - float(row[1]))

        self.last_scores = scores
        return scores


def cold_start_seconds(model_dir: Path = RERANKER_MODEL_DIR) -> float:
    """How long it takes to load the reranker and score one pair."""
    started = time.perf_counter()
    encoder = OnnxCrossEncoder(model_dir)
    encoder.score([("probe", "def probe():\n    return 1")])
    return time.perf_counter() - started
