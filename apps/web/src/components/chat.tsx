'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';

import KodeksApproval from '@/components/kodeks-approval';
import LoadingMessage from '@/components/loading-message';
import { MaterialIcon } from '@/components/material-icon';
import Message from '@/components/message';
import RuntimeItem from '@/components/runtime-item';
import ToolCall from '@/components/tool-call';
import type { TimelineItem } from '@/lib/conversation-timeline';
import type { UiCopy } from '@/lib/ui-copy';

type ChatProps = {
  items: TimelineItem[];
  isAssistantLoading: boolean;
  copy: UiCopy;
  selectedFiles?: string[];
  onSendMessage: (message: string) => void;
  onStop: () => void;
  onApprovalResponse: (decision: 'approve' | 'reject', id: string) => void;
};

// 渲染 Kodeks 聊天区，并接收统一的语言文案配置。
const Chat: React.FC<ChatProps> = ({
  items,
  isAssistantLoading,
  copy,
  selectedFiles = [],
  onSendMessage,
  onStop,
  onApprovalResponse
}) => {
  const itemsEndRef = useRef<HTMLDivElement>(null);
  const [inputMessageText, setInputMessageText] = useState('');
  const [isComposing, setIsComposing] = useState(false);

  // 保持最新消息可见，避免流式输出时用户看不到新内容。
  function scrollToBottom() {
    itemsEndRef.current?.scrollIntoView({ behavior: 'instant' });
  }

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !event.shiftKey && !isComposing) {
        event.preventDefault();
        if (!inputMessageText.trim() || isAssistantLoading) {
          return;
        }
        onSendMessage(inputMessageText);
        setInputMessageText('');
      }
    },
    [inputMessageText, isAssistantLoading, isComposing, onSendMessage]
  );

  useEffect(() => {
    scrollToBottom();
  }, [items, isAssistantLoading]);

  // 点击发送按钮时提交当前输入框内容。
  function handleSendClick() {
    if (!inputMessageText.trim() || isAssistantLoading) {
      return;
    }
    onSendMessage(inputMessageText);
    setInputMessageText('');
  }

  return (
    <div className="flex size-full min-h-0 items-center justify-center">
      <div className="flex h-full min-h-0 grow flex-col gap-2 md:max-w-[750px]">
        <div className="kodeks-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto px-4 md:px-10">
          <div className="mt-auto space-y-5 pt-4">
            {items.map((item) => (
              <React.Fragment key={item.id}>
                {item.type === 'tool' ? (
                  <ToolCall copy={copy.toolCall} toolCall={item} />
                ) : item.type === 'message' ? (
                  <div className="flex flex-col gap-1">
                    <Message message={item} />
                  </div>
                ) : item.type === 'approval' ? (
                  <KodeksApproval
                    copy={copy.approval}
                    item={item}
                    onRespond={onApprovalResponse}
                  />
                ) : (
                  <RuntimeItem copy={copy.runtime} item={item} />
                )}
              </React.Fragment>
            ))}
            {isAssistantLoading && <LoadingMessage />}
            <div ref={itemsEndRef} />
          </div>
        </div>
        <div className="shrink-0 p-3 px-2 md:p-4 md:px-10">
          <div className="flex items-center">
            <div className="flex w-full items-center pb-4 md:pb-1">
              <div className="flex w-full flex-col gap-1.5 rounded-[20px] border border-stone-200 bg-white p-2.5 pl-1.5 shadow-sm transition-colors dark:border-zinc-800 dark:bg-zinc-900">
                <div className="flex items-end gap-1.5 pl-4 md:gap-2">
                  <div className="flex min-w-0 flex-1 flex-col">
                    {selectedFiles.length > 0 ? (
                      <div className="mb-1 flex flex-wrap gap-1.5 pr-2">
                        {selectedFiles.slice(0, 4).map((path) => (
                          <span
                            className="kodeks-ui-caption max-w-48 truncate rounded-full bg-zinc-100 px-2 py-1 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                            key={path}
                            title={path}
                          >
                            {path}
                          </span>
                        ))}
                        {selectedFiles.length > 4 ? (
                          <span className="kodeks-ui-caption rounded-full bg-zinc-100 px-2 py-1 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                            +{selectedFiles.length - 4}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                    <textarea
                      className="kodeks-chat-text mb-2 resize-none border-0 bg-transparent px-0 pb-6 pt-2 text-zinc-950 placeholder:text-zinc-400 focus:outline-none dark:text-zinc-50 dark:placeholder:text-zinc-500"
                      dir="auto"
                      id="prompt-textarea"
                      onChange={(event) =>
                        setInputMessageText(event.target.value)
                      }
                      onCompositionEnd={() => setIsComposing(false)}
                      onCompositionStart={() => setIsComposing(true)}
                      onKeyDown={handleKeyDown}
                      placeholder={copy.chat.composerPlaceholder}
                      rows={2}
                      tabIndex={0}
                      value={inputMessageText}
                    />
                  </div>
                  <button
                    aria-label={copy.chat.send}
                    className="flex size-8 items-center justify-center rounded-full bg-black text-white transition-colors hover:opacity-70 focus-visible:outline-none focus-visible:outline-black disabled:bg-[#D7D7D7] disabled:text-[#f4f4f4] disabled:hover:opacity-100 dark:bg-white dark:text-zinc-950 dark:focus-visible:outline-white dark:disabled:bg-zinc-700 dark:disabled:text-zinc-500"
                    data-testid="send-button"
                    disabled={!inputMessageText.trim() || isAssistantLoading}
                    onClick={handleSendClick}
                    type="button"
                  >
                    <MaterialIcon name="arrow_upward" size={20} />
                  </button>
                </div>
                {isAssistantLoading ? (
                  <div className="flex justify-end pl-4">
                    <button
                      className="kodeks-control-text inline-flex h-8 items-center gap-1.5 rounded-full bg-zinc-100 px-3 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
                      onClick={onStop}
                      type="button"
                    >
                      <MaterialIcon name="stop_circle" size={15} />
                      {copy.chat.stop}
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Chat;
