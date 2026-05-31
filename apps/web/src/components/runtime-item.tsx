import React from "react";

import { MaterialIcon } from "@/components/material-icon";
import {
  type TimelineCompletionItem,
  type TimelineErrorItem,
  type TimelineMemoryItem,
  type TimelinePlanItem,
  type TimelineStatusItem,
  type TimelineSubagentItem,
} from "@/lib/conversation-timeline";
import type { UiCopy } from "@/lib/ui-copy";

type RuntimeItemProps = {
  item:
    | TimelineCompletionItem
    | TimelineMemoryItem
    | TimelinePlanItem
    | TimelineStatusItem
    | TimelineSubagentItem
    | TimelineErrorItem;
  copy: UiCopy["runtime"];
};

// 渲染轻量级 runtime 事件，例如记忆召回、子代理状态和响应完成。
export default function RuntimeItem({ item, copy }: RuntimeItemProps) {
  const iconName =
    item.type === "memory"
      ? "memory"
      : item.type === "plan"
        ? "fact_check"
        : item.type === "error"
          ? "error"
          : item.type === "subagent"
            ? "account_tree"
            : item.type === "completed"
              ? "check"
              : "hourglass_empty";
  const title =
    item.type === "memory"
      ? copy.memoryRecalled
      : item.type === "plan"
        ? item.action === "created"
          ? copy.planCreated
          : copy.planRecovered
        : item.type === "error"
          ? copy.error
          : item.type === "subagent"
            ? item.status === "running"
              ? copy.subagentStarted(item.agent)
              : copy.subagentCompleted(item.agent)
            : item.type === "completed"
              ? copy.responseCompleted
              : copy.status;
  const detail =
    item.type === "memory"
      ? formatMemoryDetail(item, copy)
      : item.type === "plan"
        ? copy.planDetail(item.title, item.stepCount)
        : item.type === "error"
          ? item.message
          : item.type === "subagent"
            ? (item.summary ?? item.runId)
            : item.type === "completed"
              ? item.responseId
              : item.message;
  const toneClass =
    item.type === "error" ? "text-red-600 dark:text-red-400" : "text-blue-500";

  return (
    <div className="flex justify-start pt-2">
      <div
        className={`ml-[-8px] flex max-w-[70%] items-center gap-2 ${toneClass}`}
      >
        <MaterialIcon name={iconName} size={16} />
        <div className="kodeks-ui-label min-w-0">
          <span>{title}</span>
          <span className="kodeks-ui-caption ml-2 text-zinc-500 dark:text-zinc-400">
            {detail}
          </span>
        </div>
      </div>
    </div>
  );
}

// Formats layered memory counts while preserving the legacy id list fallback.
function formatMemoryDetail(
  item: TimelineMemoryItem,
  copy: UiCopy["runtime"],
): string {
  const layers = item.layers ?? {};
  const layerText = Object.entries(layers)
    .filter(([, count]) => count > 0)
    .map(([layer, count]) => `${layer}:${count}`)
    .join(" · ");
  if (layerText.length > 0) {
    return layerText;
  }
  return item.memoryIds.join(", ") || copy.zeroMemories;
}
