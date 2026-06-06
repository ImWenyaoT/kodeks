"use client";

// frontend/components/chat/Composer.tsx
// 消息输入区（Task 4.3）。承载多行 textarea + 发送按钮，并在上方渲染已选文件
// chip 行；turn 运行中时把发送按钮切换为「停止」控件。提交经由 useChatStream()
// 接入流式后端。
//
// 交互（与既有前端对齐）：
//   - Enter 提交（调用 send）；Shift+Enter 插入换行（不提交）；
//   - 表单 onSubmit 亦触发提交（点击发送按钮 / 移动端输入法回车）；
//   - 提交成功后清空 textarea；
//   - 发送按钮在「输入为空」或「运行中」时 disabled。
//
// 无障碍（Apple HIG）：
//   - 发送 / 停止均为真实 <button>，≥44×44 触控目标（size-11 / min-h-11 min-w-11）
//     且带 aria-label；焦点可见由 shadcn button 的 focus-visible 环处理；
//   - 发送按钮带 aria-busy={isRunning}，向 AT 播报忙碌态；
//   - disabled 态用真实 disabled 属性（AT 可感知），非仅靠低对比配色；
//   - placeholder 沿用 shadcn 的 placeholder:text-muted-foreground（AA 安全），
//     不引入更低对比的占位色；
//   - 安全区内边距（safe-b/safe-x）由父级 Shell 的底部容器统一处理，
//     本组件不重复施加，避免双重 padding。

import { useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUp } from "lucide-react";

import { useI18n } from "@/components/providers/I18nProvider";
import { useChatStream } from "@/hooks/useChatStream";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SelectedFileChips } from "@/components/chat/SelectedFileChips";
import { StopButton } from "@/components/chat/StopButton";

/**
 * 消息输入区主组件。
 * 维护本地输入 state，提交时委托给 useChatStream().send，并在运行态切换控件。
 */
export function Composer() {
  const { t } = useI18n();
  const { send, stop, isRunning } = useChatStream();
  // 本地输入草稿；store 不保存草稿（提交后即写入消息列表）。
  const [input, setInput] = useState("");

  // 去除首尾空白后是否有内容——决定发送按钮是否可用。
  const canSend = input.trim().length > 0 && !isRunning;

  /**
   * 提交一条消息。
   * 校验非空且非运行中后调用 send，并立即清空草稿；send 内部自行管理运行态。
   */
  const submit = () => {
    const text = input.trim();
    if (text.length === 0 || isRunning) return;
    // 先清空再 send：避免 await 期间用户看到旧文本；send 已将文本快照入参。
    setInput("");
    void send(text);
  };

  /**
   * 表单提交处理：阻止默认刷新后走统一的 submit 流程。
   * 覆盖「点击发送按钮」与「移动端输入法回车」两条路径。
   */
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submit();
  };

  /**
   * textarea 键盘处理：Enter 提交、Shift+Enter 换行。
   * 仅在裸 Enter（无 Shift，且非输入法 composing）时拦截默认换行并提交。
   */
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // event.nativeEvent.isComposing：输入法候选阶段的 Enter 不应触发提交。
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form onSubmit={handleSubmit} className="w-full">
      {/* 已选文件 chip 行：无选中文件时自身返回 null，不占空间。 */}
      <SelectedFileChips />

      {/* 输入卡片：textarea + 发送按钮同处一张圆角卡片内，贴近 HIG 输入控件观感。 */}
      <div className="flex items-end gap-2 rounded-2xl border border-border bg-card p-2 shadow-sm transition-colors focus-within:border-ring">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t.composer}
          aria-label={t.composer}
          rows={1}
          // 去掉 Textarea 自带边框/底色，让其融入外层卡片；field-sizing 自动增高。
          className="max-h-48 min-h-11 flex-1 resize-none border-0 bg-transparent py-2.5 shadow-none focus-visible:border-0 focus-visible:ring-0"
        />

        {/* 发送按钮：始终渲染。运行中 disabled 并以 aria-busy 向 AT 播报忙碌；
            真正的中断由下方独立的「停止」行承担（运行中才出现）。 */}
        <Button
          type="submit"
          disabled={!canSend}
          aria-label={t.send}
          aria-busy={isRunning}
          // size-11 = 44×44 触控目标；rounded-full 呼应 HIG 发送圆钮。
          className="size-11 shrink-0 rounded-full"
        >
          <ArrowUp className="size-5" aria-hidden="true" />
          <span className="sr-only">{t.send}</span>
        </Button>
      </div>

      {/* 停止行：仅运行中出现，整行铺满便于触达；点击 stop() 中断当前 turn。 */}
      {isRunning && (
        <div className="mt-2 flex justify-center">
          <StopButton onStop={stop} label={t.stop} className="w-full sm:w-auto sm:px-6" />
        </div>
      )}
    </form>
  );
}
