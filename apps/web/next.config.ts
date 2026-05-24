import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "@kodeks/agent-runtime",
    "@kodeks/model",
    "@kodeks/storage",
    "@kodeks/tools",
    "@kodeks/workspace"
  ]
};

export default nextConfig;
