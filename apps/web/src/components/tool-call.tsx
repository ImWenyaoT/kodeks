import React from 'react';

import { MaterialIcon } from '@/components/material-icon';
import {
  formatTimelinePayload,
  type TimelineToolItem
} from '@/lib/conversation-timeline';
import type { UiCopy } from '@/lib/ui-copy';

type ToolCallProps = {
  toolCall: TimelineToolItem;
  copy: UiCopy['toolCall'];
};

// 渲染工具调用卡片，展示调用状态和输入/输出 payload。
export default function ToolCall({ toolCall, copy }: ToolCallProps) {
  const isDone = toolCall.status === 'completed';
  const isWaiting = toolCall.status === 'approval_required';
  const payload = formatTimelinePayload(toolCall.output ?? toolCall.input);

  return (
    <div className="flex justify-start pt-2">
      <div className="relative mb-[-8px] flex w-[70%] min-w-0 flex-col">
        <div className="flex flex-col rounded-[16px] text-sm">
          <div className="flex gap-2 rounded-b-none p-3 pl-0 font-semibold text-gray-700 dark:text-zinc-200">
            <div className="ml-[-8px] flex items-center gap-2 text-blue-500">
              <MaterialIcon
                name={isWaiting ? 'shield' : 'terminal'}
                size={16}
              />
              <div className="text-sm font-medium">
                {isWaiting
                  ? copy.approvalNeeded(toolCall.name)
                  : isDone
                    ? copy.called(toolCall.name)
                    : copy.calling(toolCall.name)}
              </div>
            </div>
          </div>

          <div className="ml-4 mt-2 rounded-xl bg-[#fafafa] py-2 dark:bg-zinc-900">
            <pre className="mx-6 max-h-96 overflow-y-scroll border-b border-stone-200 p-2 pl-0 text-xs text-zinc-700 dark:border-zinc-800 dark:text-zinc-300">
              {payload || copy.waitingForResult}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
