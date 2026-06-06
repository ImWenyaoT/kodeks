// frontend/components/chat/MessageBubble.tsx
// 单条消息气泡（Task 4.2）。按角色呈现不同的对齐与样式：
//   - user：右对齐、强调底色（primary），形如「自己说的话」；
//   - assistant：左对齐、柔和底色（muted），形如「对方回复」；
//   - runtime：左对齐、更弱的底色 + 等宽字体（font-mono），形如「系统/运行事件」。
//
// 设计遵循 Apple HIG：
//   - 字号用 rem 级（text-sm/text-base），随用户字体大小缩放（Dynamic Type）；
//   - 文字配色全部走 shadcn 语义 token（*-foreground），对各自底色满足 AA 对比度；
//   - 角色区分不依赖颜色：对齐方向、圆角缺口方向、字体（等宽）共同传达，
//     即便色盲/灰度也能分辨「谁说的」；
//   - whitespace-pre-wrap + 折行处理，保留换行并避免长串溢出。

import type { Role } from "@/stores/chat-store";
import { cn } from "@/lib/utils";

/**
 * 气泡组件的属性。
 * @param role 消息角色，决定对齐与样式。
 * @param text 消息正文（保留空白与换行）。
 */
export interface MessageBubbleProps {
  role: Role;
  text: string;
}

/**
 * 渲染一条消息气泡。
 * 外层 <div> 负责行内对齐（user 靠右、其余靠左），内层气泡承载底色与文字样式。
 * @param role 消息角色。
 * @param text 消息正文。
 */
export function MessageBubble({ role, text }: MessageBubbleProps) {
  // 是否为用户消息——用户气泡整体靠右，并采用强调底色。
  const isUser = role === "user";
  // 是否为运行时事件——采用等宽字体与更弱的视觉权重。
  const isRuntime = role === "runtime";

  return (
    <div
      // 行容器：仅 user 靠右，assistant / runtime 靠左。对齐本身即角色信号之一。
      className={cn("flex w-full", isUser ? "justify-end" : "justify-start")}
    >
      <div
        className={cn(
          // 通用气泡外形：限制最大宽度避免长段落铺满整行，rem 级内边距与圆角。
          "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed sm:max-w-[80%]",
          // 保留换行/空白，并让超长无空格串（URL、路径）也能折行，避免横向溢出。
          "whitespace-pre-wrap [overflow-wrap:anywhere]",
          // 角色配色 + 形状缺口（靠近发送方一侧收紧圆角，强化「来源方向」语义）：
          isUser &&
            "rounded-br-md bg-primary text-primary-foreground shadow-sm",
          role === "assistant" &&
            "rounded-bl-md bg-muted text-foreground shadow-sm",
          // runtime：最弱的底色 + 等宽字体 + 次级文字色，明确「这是系统输出」。
          isRuntime &&
            "rounded-bl-md bg-muted/60 font-mono text-[0.8125rem] text-muted-foreground",
        )}
      >
        {text}
      </div>
    </div>
  );
}
