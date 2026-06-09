"use client";

// frontend/app/page.tsx
// 应用首页：直接渲染响应式工作区外壳 <Shell />。
// 页面本身保持极薄——三区布局、响应式与无障碍细节全部封装在 Shell 中。
// 功能内容（对话转录、Composer、会话列表等）属于 Phase 4，此处仅外壳与占位。

import { Shell } from "@/components/Shell";

/**
 * 首页根组件。客户端组件（"use client"）以便 Shell 内部使用 useState / useI18n。
 */
export default function Home() {
  return <Shell />;
}
