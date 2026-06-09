"use client";

// frontend/components/tools/ApprovalList.tsx
// 待审批队列（Task 4.8）：把 store.approvals 渲染为一组卡片，每张卡片展示审批消息，
// 并提供「批准 / 拒绝」两个动作。数据来源：chat-store（approvals）+ useApprovals（decide）。
//
// HIG / 无障碍要点：
//   - 容器为 aria-live="assertive" + aria-label={t.approvals}：审批需要用户注意，
//     新审批到达时屏幕阅读器会即时播报（修复审计「approvals/runtime updates not
//     announced」的 P0 发现）。assertive 表示「打断当前播报、优先告知」。
//   - Approve / Reject 是真实 <button>，各带显式 aria-label（动作 + 消息上下文），
//     ≥44px 最小高度（h-11）保证触控目标，并具可见键盘焦点（Button 自带 ring）。
//   - 两个动作不靠颜色单独区分：文字标签（批准/拒绝）+ 不同 variant（default / outline）
//     + 各自图标，灰度/色盲下仍可分辨。
//   - 无待审批时渲染极轻量的空状态提示（保持安静，不喧宾夺主）。

import { Check, ShieldCheck, X } from "lucide-react";

import { useI18n } from "@/components/providers/I18nProvider";
import { useChatStore } from "@/stores/chat-store";
import { useApprovals } from "@/hooks/useApprovals";
import { Button } from "@/components/ui/button";
import type { Approval } from "@/stores/chat-store";

/**
 * 单张审批卡片：展示审批消息 + 批准/拒绝按钮。
 * 两个按钮的 aria-label 都附带消息上下文，避免多卡片时「批准/拒绝」歧义。
 * @param approval 待审批项（approvalId + message）。
 * @param onDecide 决策回调（来自 useApprovals.decide）。
 * @param busy     该卡片是否正在决策中（禁用按钮，防重复提交）。
 */
function ApprovalCard({
  approval,
  onDecide,
  busy,
}: {
  approval: Approval;
  onDecide: (approvalId: string, decision: "approve" | "reject") => void;
  busy: boolean;
}) {
  const { t } = useI18n();
  return (
    <li className="rounded-xl border border-l-4 border-border border-l-status-warn bg-card p-3">
      {/* 审批消息：保留换行、长串可折行，避免横向溢出。 */}
      <p className="text-sm [overflow-wrap:anywhere] whitespace-pre-wrap text-foreground">
        {approval.message}
      </p>

      {/* 动作区：批准（强调）+ 拒绝（描边）。文字 + 图标 + variant 三重区分，不依赖颜色。 */}
      <div className="mt-3 flex gap-2">
        <Button
          type="button"
          variant="default"
          onClick={() => onDecide(approval.approvalId, "approve")}
          disabled={busy}
          aria-label={`${t.approve}: ${approval.message}`}
          className="h-11 flex-1 gap-1.5 rounded-lg"
        >
          <Check className="size-4" aria-hidden="true" />
          {t.approve}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => onDecide(approval.approvalId, "reject")}
          disabled={busy}
          aria-label={`${t.reject}: ${approval.message}`}
          className="h-11 flex-1 gap-1.5 rounded-lg"
        >
          <X className="size-4" aria-hidden="true" />
          {t.reject}
        </Button>
      </div>
    </li>
  );
}

/**
 * 待审批队列组件。
 * 订阅 store.approvals 渲染卡片列表；通过 useApprovals.decide 提交决策。
 * 容器始终存在并带 aria-live/aria-label，以便新审批到达时被 AT 播报；
 * 无待审批时仅渲染一条安静的空状态提示。
 */
export function ApprovalList() {
  const { t } = useI18n();
  const approvals = useChatStore((s) => s.approvals);
  const { decide, deciding } = useApprovals();

  return (
    // aria-live="assertive"：审批需要注意，新增项即时播报；aria-label 命名该 live region。
    <div aria-live="assertive" aria-label={t.approvals}>
      {approvals.length === 0 ? (
        // 空状态：保持安静的次级提示，不使用喧闹的占位块。
        <p className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
          <ShieldCheck className="size-3.5" aria-hidden="true" />
          {t.approvals}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {approvals.map((approval) => (
            <ApprovalCard
              key={approval.approvalId}
              approval={approval}
              onDecide={decide}
              busy={deciding === approval.approvalId}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
