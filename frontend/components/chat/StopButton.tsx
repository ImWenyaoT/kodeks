"use client";

// frontend/components/chat/StopButton.tsx
// 停止按钮（Task 4.3）。turn 运行中（isRunning）时由 Composer 展示，点击调用
// useChatStream().stop() 中断当前请求。
//
// 无障碍（Apple HIG）：
//   - 真实 <button>，≥44×44 触控目标（size-11 = 44px）；
//   - aria-label = t.stop，可见文字标签亦同（不仅靠图标/颜色传达含义）；
//   - 焦点可见由 button variant 的 focus-visible 环统一处理。

import { Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * 停止按钮属性。
 * @param onStop 点击回调（中断当前 turn）。
 * @param label  无障碍标签 + 可见文字（取自 i18n t.stop）。
 * @param className 额外类名（供 Composer 控制布局，如 w-full）。
 */
export interface StopButtonProps {
  onStop: () => void;
  label: string;
  className?: string;
}

/**
 * 渲染「停止」控件。
 * 用 destructive 视觉变体以区别于发送，但停止语义同时由文字标签明示。
 */
export function StopButton({ onStop, label, className }: StopButtonProps) {
  return (
    <Button
      type="button"
      variant="destructive"
      onClick={onStop}
      aria-label={label}
      // min-h/min-w-11 保证 44×44 触控目标，即便父容器拉伸为 w-full 也满足高度。
      className={cn("min-h-11 min-w-11 gap-2 rounded-xl", className)}
    >
      <Square className="size-4 fill-current" aria-hidden="true" />
      {label}
    </Button>
  );
}
