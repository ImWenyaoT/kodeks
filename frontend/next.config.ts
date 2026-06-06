import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";
const API = process.env.KODEKS_API_ORIGIN ?? "http://127.0.0.1:8000";

const nextConfig: NextConfig = {
  output: "export",                 // emit static HTML/CSS/JS into ./out
  images: { unoptimized: true },    // no runtime image optimizer in static export
  // Dev-only proxy so the SPA can call the FastAPI backend during `next dev`.
  // Rewrites are ignored by `output: export` builds (dev server only) — intended.
  async rewrites() {
    if (!isDev) return [];
    return [
      { source: "/api/:path*", destination: `${API}/api/:path*` },
      { source: "/health", destination: `${API}/health` },
      { source: "/v1/:path*", destination: `${API}/v1/:path*` },
    ];
  },
};

export default nextConfig;
