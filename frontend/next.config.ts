import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NextConfig } from 'next'

const projectRoot = path.dirname(fileURLToPath(import.meta.url))

// 双进程架构：Next 仅渲染 React UI；所有后端 API 反向代理到本地 Python FastAPI（uvicorn :8000）。
// 浏览器视角全部同源（只与 Next 通信），因此无需 CORS，KODEKS_CORS_ORIGINS 可留空。
// KODEKS_API_ORIGIN 缺省指向本地 uvicorn；生产环境指向独立部署的 Python 服务。
const apiOrigin = process.env.KODEKS_API_ORIGIN ?? "http://127.0.0.1:8000";

const nextConfig: NextConfig = {
  images: { unoptimized: true },
  // 显式指定 tracing/turbopack 根，避免在多包 workspace 中误判项目根（来自 f5376fe）。
  outputFileTracingRoot: projectRoot,
  turbopack: {
    root: projectRoot,
  },
  /**
   * 把后端路由反代到 Python。rewrites 不改地址栏、不触发 CORS，
   * 并以流式透传响应体（chat SSE 走 POST fetch-stream，无 [DONE] 终止符，靠连接关闭收尾）。
   */
  async rewrites() {
    return [
      // 客户端实际调用的 7 个 /api/*（含 SSE chat stream）。
      { source: "/api/:path*", destination: `${apiOrigin}/api/:path*` },
      // 健康探针（部署/冒烟用；Python 返回 {ok, runtime:'python'}）。
      { source: "/health", destination: `${apiOrigin}/health` },
      // 内部 MoonBridge OpenAI 兼容面（无浏览器调用，保留以便工具/脚本直连）。
      { source: "/v1/:path*", destination: `${apiOrigin}/v1/:path*` },
      { source: "/responses", destination: `${apiOrigin}/responses` },
      { source: "/models", destination: `${apiOrigin}/models` },
      { source: "/bridge/health", destination: `${apiOrigin}/bridge/health` },
      // 注意：不代理 "/" 与 "/favicon.ico" —— 这两个由 Next 自身提供 UI/图标。
    ];
  },
};

export default nextConfig
