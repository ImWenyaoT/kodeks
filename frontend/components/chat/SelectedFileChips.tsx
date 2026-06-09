"use client";

// frontend/components/chat/SelectedFileChips.tsx
// 已选文件「胶囊（chip）」行（Task 4.3）。从 chat-store 读取 selectedFiles，
// 在 Composer 上方渲染；每个 chip 是可点击的真实 <button>，点击调用 toggleFile
// 将该文件移出选择。最多展示 4 个，超出部分折叠为 "+N" 概览 chip。
//
// 无障碍（Apple HIG）：
//   - 每个 chip 是真实 <button>，带 aria-label（"Remove file: <path>" 双语字面量，
//     因当前 i18n 字典尚无对应文案键——见任务说明，已在报告中标注）；
//   - chip 仅展示文件名（basename）以节省横向空间，但完整路径同时进入
//     aria-label 与 title，保证可读性与可达性；
//   - "+N" 概览 chip 是非交互的 <span>（仅信息展示），不抢占 Tab 焦点。

import { X } from "lucide-react";

import { useI18n } from "@/components/providers/I18nProvider";
import { useChatStore } from "@/stores/chat-store";
import { cn } from "@/lib/utils";

/** 最多直接展示的 chip 数量，超出折叠为 "+N"。 */
const MAX_VISIBLE = 4;

/**
 * 从完整路径中取出用于展示的文件名（basename）。
 * 兼容 POSIX("/") 与 Windows("\\") 分隔符；空段回退为原始路径。
 * @param path 文件完整路径。
 */
function basename(path: string): string {
  const segments = path.split(/[/\\]/);
  return segments[segments.length - 1] || path;
}

/**
 * 已选文件 chip 行。
 * 无选中文件时返回 null（不占据垂直空间，让 Composer 紧贴转录区）。
 */
export function SelectedFileChips() {
  const { t } = useI18n();
  // 细粒度订阅：仅 selectedFiles 引用变化（store 用新 Set 触发）时重渲染。
  const selectedFiles = useChatStore((s) => s.selectedFiles);
  const toggleFile = useChatStore((s) => s.toggleFile);

  const files = [...selectedFiles];
  if (files.length === 0) return null;

  // 直接展示前 MAX_VISIBLE 个，其余计入 overflow 概览。
  const visible = files.slice(0, MAX_VISIBLE);
  const overflow = files.length - visible.length;

  return (
    <ul
      // 列表语义：让屏幕阅读器把「已选文件」作为一组条目导航。
      aria-label={t.selectedFileCount(files.length)}
      className="flex flex-wrap items-center gap-1.5 px-1 pb-2"
    >
      {visible.map((path) => (
        <li key={path}>
          <button
            type="button"
            // 双语字面量（i18n 暂无该文案键）：移除该文件。完整路径进 aria-label / title。
            aria-label={`移除文件 / Remove file: ${path}`}
            title={path}
            onClick={() => toggleFile(path)}
            className={cn(
              "inline-flex max-w-[14rem] items-center gap-1 rounded-full border border-border bg-muted/60 py-1 pr-1.5 pl-2.5",
              "text-xs font-medium text-foreground transition-colors hover:bg-muted",
              "outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
            )}
          >
            <span className="truncate">{basename(path)}</span>
            <X className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>
        </li>
      ))}

      {overflow > 0 && (
        // 概览 chip：仅信息展示，不可交互，故用 <span> 且不进入 Tab 序列。
        <li>
          <span className="inline-flex items-center rounded-full bg-muted/60 px-2.5 py-1 text-xs font-medium text-muted-foreground">
            +{overflow}
          </span>
        </li>
      )}
    </ul>
  );
}
