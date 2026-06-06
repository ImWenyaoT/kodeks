// frontend/hooks/useApprovals.ts
// 审批决策 hook（Task 4.8）：把 API 客户端（decideApproval）与 chat-store 粘合在一起。
// 职责：对一条待审批项做出 approve / reject 决策，并在决策成功后：
//   1) 从 store.approvals 中移除该项（removeApproval）；
//   2) 追加一条运行时事件标记（pushRuntime），供右侧「运行事件」流即时反馈；
//   3) 若后端返回了 result（命令执行结果），再向转录区追加一条 runtime 消息，
//      把 exit code / stdout / stderr 格式化展示，让用户看到批准后命令的真实输出。
// 通过 deciding（飞行中的 approvalId）守卫并发：决策进行中可禁用对应卡片的按钮。
import { useCallback, useState } from "react";

import { decideApproval } from "@/lib/api";
import { useChatStore } from "@/stores/chat-store";

/** useApprovals 的对外接口。 */
export interface ApprovalsApi {
  /** 对一条审批做出决策：批准或拒绝。 */
  decide: (approvalId: string, decision: "approve" | "reject") => Promise<void>;
  /** 正在决策中的 approvalId（无飞行请求时为 null），用于禁用对应按钮。 */
  deciding: string | null;
}

/**
 * 把后端返回的命令执行结果格式化为可读的转录文本。
 * 形如：
 *   approval result: exit 0
 *   stdout:
 *   ...
 *   stderr:
 *   ...
 * exitCode 缺省时显示 "n/a"；stdout/stderr 仅在存在时追加各自分段。
 * @param result 后端 decideApproval 返回的 result 字段。
 */
function formatResult(result: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}): string {
  let text = `approval result: exit ${result.exitCode ?? "n/a"}`;
  if (result.stdout) text += `\nstdout:\n${result.stdout}`;
  if (result.stderr) text += `\nstderr:\n${result.stderr}`;
  return text;
}

/**
 * 审批决策 hook。
 * decide() 串起「调用 API → 移除审批 → 推运行事件 →（有结果时）追加转录消息」的流程；
 * 用本地 deciding 状态跟踪飞行中的 approvalId，便于 UI 在请求期间禁用按钮、避免重复提交。
 */
export function useApprovals(): ApprovalsApi {
  // 这些 action 引用在 store 生命周期内稳定，直接取出即可。
  const removeApproval = useChatStore((s) => s.removeApproval);
  const pushRuntime = useChatStore((s) => s.pushRuntime);
  const appendMessage = useChatStore((s) => s.appendMessage);

  // 飞行中的 approvalId：用于禁用对应卡片的 Approve/Reject 按钮。
  const [deciding, setDeciding] = useState<string | null>(null);

  const decide = useCallback(
    async (approvalId: string, decision: "approve" | "reject") => {
      // 标记进入决策中（禁用该卡片按钮）。
      setDeciding(approvalId);
      try {
        const res = await decideApproval(approvalId, decision);
        // 从待审批列表移除该项。
        removeApproval(approvalId);
        // 推一条运行事件标记（最旧在前、最新在后；展示层负责倒序）。
        pushRuntime(`approval ${decision}: ${approvalId}`);
        // 若后端附带命令执行结果，追加一条 runtime 转录消息展示输出。
        if (res.result) {
          appendMessage("runtime", formatResult(res.result));
        }
      } finally {
        // 无论成功失败都清除飞行标记，避免按钮永久禁用。
        setDeciding(null);
      }
    },
    [removeApproval, pushRuntime, appendMessage],
  );

  return { decide, deciding };
}
