"use client";

// frontend/components/chat/Transcript.tsx
// 对话转录区（Task 4.2）。从 chat-store 读取消息列表，按角色逐条渲染气泡，
// 并随流式输出自动滚动到底部。
//
// 无障碍（Apple HIG / P0 审计修复）：
//   - 滚动容器声明为 live region：role="log" + aria-live="polite"
//     + aria-relevant="additions text"，使「新消息」与「助手气泡的流式增量文本」
//     都能被屏幕阅读器播报；aria-label 取 t.transcript（"对话"/"Conversation"）。
//   - 字号用 rem 级（继承自气泡），随系统字体缩放；配色走语义 token，满足 AA。
//
// 空态：无任何消息时，以 assistant 气泡样式展示欢迎语（t.welcome），
// 既给出明确引导，又与后续真实助手回复保持一致的视觉语言。

import { useEffect, useRef } from "react";

import { useI18n } from "@/components/providers/I18nProvider";
import { useChatStore } from "@/stores/chat-store";
import { MessageBubble } from "@/components/chat/MessageBubble";

/**
 * 对话转录区主组件。
 * 订阅 store 的 messages，渲染气泡列表并自动滚到底部。
 */
export function Transcript() {
  const { t } = useI18n();
  // 细粒度订阅：仅在 messages 引用变化时重渲染（store 的 action 均不可变更新）。
  const messages = useChatStore((s) => s.messages);

  // 滚动容器引用：用于在内容更新后将滚动位置推到底部。
  const scrollRef = useRef<HTMLDivElement>(null);
  // 最后一条消息的文本——作为流式增量的依赖项，使每个 delta 都触发滚动。
  const lastText = messages.length > 0 ? messages[messages.length - 1].text : "";

  // 新消息到达或最后一条消息文本增长（流式）时，自动滚动到底部。
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, lastText]);

  // 空态：没有任何消息时，以「助手气泡」样式呈现欢迎语。
  const isEmpty = messages.length === 0;

  return (
    <div
      ref={scrollRef}
      // live region：让流式文本与新消息对屏幕阅读器可播报（P0 审计修复，必须保留）。
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
      aria-label={t.transcript}
      className="flex-1 space-y-3 overflow-y-auto py-4"
    >
      {isEmpty ? (
        // 欢迎语复用 assistant 气泡，保持空态与真实回复的一致观感。
        <MessageBubble role="assistant" text={t.welcome} />
      ) : (
        messages.map((message) => (
          <MessageBubble
            key={message.id}
            role={message.role}
            text={message.text}
          />
        ))
      )}
    </div>
  );
}
