import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    formats: ["image/avif", "image/webp"],
  },
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
  /**
   * The embedding model is bundled with the deployment.
   *
   * `models/Xenova/all-MiniLM-L6-v2` holds the ONNX weights, the tokenizer and the
   * config for the local `Xenova/all-MiniLM-L6-v2` model. It is 22.6 MB and
   * it is committed to the repository on purpose.
   *
   * Next.js only traces the files a route statically imports, and the model
   * folder is read from the filesystem at runtime rather than imported, so
   * it would be left out of the serverless bundle. Without these includes
   * the deployed assistant answers every code question from the claim
   * ledger instead of from the source, because the model cannot be loaded.
   *
   * The route globs cover every route that can reach the retrieval layer:
   * the chat endpoint, the health check, and the MCP server.
   */
  outputFileTracingIncludes: {
    "/api/chat": ["./models/Xenova/all-MiniLM-L6-v2/**/*"],
    "/api/health": ["./models/Xenova/all-MiniLM-L6-v2/**/*"],
    "/mcp": ["./models/Xenova/all-MiniLM-L6-v2/**/*"],
  },
};

export default nextConfig;

