"use client";

// frontend/components/tools/RuntimeEvents.tsx
// 运行事件流 + 概要（Task 4.8）：把 store.runtimeEvents 渲染为紧凑的事件行，
// 并在顶部给出一行概要（当前会话 + 事件计数）。数据来源：chat-store
// （runtimeEvents / sessionId）。
//
// HIG / 无障碍要点：
//   - 事件流容器为 aria-live="polite" + aria-label={t.activity}：新事件到达时
//     屏幕阅读器会在用户空闲时礼貌播报，不打断当前操作（修复审计「runtime
//     updates not announced」的 P0 发现）。
//   - 事件行为纯文字内容，等宽字体提升可读性；不使用「仅颜色」传达任何含义。
//   - store 以「最旧在前、最新在后」追加；展示层倒序，使最新事件置顶（newest first）。
//   - 概要行用 label/value 文字成对呈现，会话为空时回退到 t.autoSession。

import { Activity } from "lucide-react";

import { useI18n } from "@/components/providers/I18nProvider";
import { useChatStore } from "@/stores/chat-store";

/**
 * 运行事件流组件。
 * 顶部概要：会话标识（sessionId 或自动会话）+ 事件计数；
 * 下方按「最新在前」倒序渲染事件行。容器带 aria-live="polite" 以便新事件被播报。
 */
export function RuntimeEvents() {
  const { t } = useI18n();
  const runtimeEvents = useChatStore((s) => s.runtimeEvents);
  const sessionId = useChatStore((s) => s.sessionId);

  // 概要：会话标识空时回退到「自动会话」文案。
  const sessionLabel = sessionId || t.autoSession;
  // 倒序副本：store 追加为最旧→最新，展示需最新在前。slice() 避免原地反转污染 store。
  const eventsNewestFirst = runtimeEvents.slice().reverse();

  return (
    <div className="flex flex-col gap-2">
      {/* 概要行：会话标识 + 事件计数。纯文字成对呈现。 */}
      <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/40 px-2.5 py-1.5 text-xs">
        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
          <Activity className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate" title={sessionLabel}>
            {t.session}: {sessionLabel}
          </span>
        </span>
        {/* 事件计数：以无障碍数值标签命名，便于 AT 朗读「Runtime events: N」。 */}
        <span
          className="shrink-0 font-medium tabular-nums text-foreground"
          aria-label={`${t.runtimeEvents}: ${runtimeEvents.length}`}
        >
          {runtimeEvents.length}
        </span>
      </div>

      {/* 事件流：aria-live="polite" 礼貌播报新事件；aria-label 命名该 live region。 */}
      <div aria-live="polite" aria-label={t.activity}>
        {eventsNewestFirst.length === 0 ? (
          // 空状态：安静的次级提示。
          <p className="px-1 text-xs text-muted-foreground">{t.activity}</p>
        ) : (
          <ol className="flex flex-col gap-1">
            {eventsNewestFirst.map((event, index) => (
              <li
                // 倒序后用「原始下标」作为稳定 key：原始顺序中事件只追加不重排，下标稳定。
                key={runtimeEvents.length - 1 - index}
                className="rounded-md bg-muted/30 px-2.5 py-1.5 font-mono text-[0.75rem] leading-snug [overflow-wrap:anywhere] whitespace-pre-wrap text-muted-foreground"
              >
                {event}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
