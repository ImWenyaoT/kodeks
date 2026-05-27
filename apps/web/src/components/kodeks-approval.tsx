"use client";

import React, { useState } from "react";

import { MaterialIcon } from "@/components/material-icon";
import type { TimelineApprovalItem } from "@/lib/conversation-timeline";
import type { UiCopy } from "@/lib/ui-copy";

type KodeksApprovalProps = {
  item: TimelineApprovalItem;
  copy: UiCopy["approval"];
  onRespond: (decision: "approve" | "reject", id: string) => void;
};

// 渲染工具调用审批卡片，并把用户决策交回上层处理。
export default function KodeksApproval({ item, copy, onRespond }: KodeksApprovalProps) {
  const [disabled, setDisabled] = useState(false);

  // 先禁用按钮，避免用户连续点击造成重复审批。
  function handleDecision(decision: "approve" | "reject") {
    setDisabled(true);
    onRespond(decision, item.approvalId);
  }

  return (
    <div className="flex flex-col">
      <div className="flex">
        <div className="mr-4 rounded-[16px] bg-gray-100 p-4 font-light text-black dark:bg-zinc-900 dark:text-zinc-50 md:mr-24">
          <div className="mb-2 text-sm">
            {copy.request(item.toolCallId ?? item.approvalId)}
          </div>
          <div className="mb-3 max-w-xl whitespace-pre-wrap text-xs text-zinc-600 dark:text-zinc-400">{item.reason}</div>
          {item.state === "waiting" ? (
            <div className="flex gap-2">
              <button
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-black px-3 text-xs font-medium text-white disabled:bg-zinc-300 dark:bg-white dark:text-zinc-950 dark:disabled:bg-zinc-700 dark:disabled:text-zinc-500"
                disabled={disabled}
                onClick={() => handleDecision("approve")}
                type="button"
              >
                <MaterialIcon name="check" size={14} />
                {copy.approve}
              </button>
              <button
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-gray-200 px-3 text-xs font-medium text-gray-700 hover:bg-gray-300 disabled:text-zinc-400 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
                disabled={disabled}
                onClick={() => handleDecision("reject")}
                type="button"
              >
                <MaterialIcon name="close" size={14} />
                {copy.decline}
              </button>
            </div>
          ) : (
            <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{item.state}</div>
          )}
        </div>
      </div>
    </div>
  );
}
