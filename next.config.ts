import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    formats: ["image/avif", "image/webp"],
  },
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
  serverExternalPackages: [
    "@huggingface/transformers",
    "onnxruntime-node",
    "onnxruntime-common",
    "sharp",
  ],
  /**
   * The MODELS are bundled with the deployment.
   *
   * Two of them, and both are committed to the repository on purpose:
   *
   *   models/Xenova/all-MiniLM-L6-v2       22.6 MB - the bi-encoder that
   *                                         embeds the question and the code
   *   models/Xenova/ms-marco-MiniLM-L-6-v2   23.0 MB - the cross-encoder that
   *                                         reranks the top 20 candidates
   *
   * Next.js only traces the files a route statically imports, and the model
   * folders are read from the filesystem at runtime rather than imported, so
   * they would be left out of the serverless bundle. Without these includes
   * the deployed assistant answers every code question from the claim
   * ledger instead of from the source, because the model cannot be loaded.
   *
   * The reranker matters as much as the embedder: without it the retriever
   * still finds the right file most of the time, but it ranks the wrong
   * chunk inside it far more often. `docs/RETRIEVAL.md` has the numbers.
   *
   * The route globs cover every route that can reach the retrieval layer:
   * the chat endpoint, the health check, and the MCP server.
   */
  outputFileTracingIncludes: {
    "/api/chat": [
      "./models/Xenova/all-MiniLM-L6-v2/**/*",
      "./models/Xenova/ms-marco-MiniLM-L-6-v2/**/*",
      "./node_modules/onnxruntime-node/bin/napi-v6/linux/x64/**/*",
      "./node_modules/onnxruntime-node/dist/**/*",
      "./node_modules/onnxruntime-node/lib/**/*",
      "./node_modules/onnxruntime-node/package.json",
      "./node_modules/onnxruntime-common/**/*",
    ],
    "/api/health": [
      "./models/Xenova/all-MiniLM-L6-v2/**/*",
      "./models/Xenova/ms-marco-MiniLM-L-6-v2/**/*",
      "./node_modules/onnxruntime-node/bin/napi-v6/linux/x64/**/*",
      "./node_modules/onnxruntime-node/dist/**/*",
      "./node_modules/onnxruntime-node/lib/**/*",
      "./node_modules/onnxruntime-node/package.json",
      "./node_modules/onnxruntime-common/**/*",
    ],
    "/mcp": [
      "./models/Xenova/all-MiniLM-L6-v2/**/*",
      "./models/Xenova/ms-marco-MiniLM-L-6-v2/**/*",
      "./node_modules/onnxruntime-node/bin/napi-v6/linux/x64/**/*",
      "./node_modules/onnxruntime-node/dist/**/*",
      "./node_modules/onnxruntime-node/lib/**/*",
      "./node_modules/onnxruntime-node/package.json",
      "./node_modules/onnxruntime-common/**/*",
    ],
  },
  outputFileTracingExcludes: {
    "*": [
      "./node_modules/onnxruntime-node/bin/napi-v6/darwin/**/*",
      "./node_modules/onnxruntime-node/bin/napi-v6/win32/**/*",
      "./node_modules/onnxruntime-node/bin/napi-v6/linux/arm64/**/*",
    ],
  },
};

export default nextConfig;

