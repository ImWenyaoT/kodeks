import type { NextConfig } from "next";

// M5: 关闭静态导出（output:'export'）—— /api 路由现已同源（App Router route handlers），
// 不再需要 dev rewrite 把 /api 代理到 FastAPI。保留 images.unoptimized（无运行时图片优化器）。
const nextConfig: NextConfig = {
  images: { unoptimized: true },
};

export default nextConfig;
