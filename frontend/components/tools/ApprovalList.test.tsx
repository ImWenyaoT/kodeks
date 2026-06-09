// frontend/components/tools/ApprovalList.test.tsx
// 待审批队列（Task 4.8）测试：
//   1. 播种一条审批 → 渲染其消息 + 批准/拒绝按钮；
//   2. 点击批准 → 调用 decideApproval(id,"approve")、从 store.approvals 移除该项，
//      且（mock 返回 result 时）向转录追加一条 runtime 消息 + 推一条运行事件；
//   3. 容器暴露 aria-live + aria-label；
//   4. axe(container) 零无障碍违规。
// 通过 mock @/lib/api 的 decideApproval 隔离网络；matchMedia 桩件供 next-themes；
// 每个用例前 reset store 并播种审批。

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";

import { ApprovalList } from "./ApprovalList";
import { I18nProvider } from "@/components/providers/I18nProvider";
import { ThemeProvider } from "@/components/providers/ThemeProvider";
import { useChatStore } from "@/stores/chat-store";
import { copy } from "@/lib/i18n";
import * as api from "@/lib/api";

// vitest-axe 的类型增强（运行期匹配器在 test/setup.ts 注册）。
declare module "@vitest/expect" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Matchers<T = any> {
    toHaveNoViolations(): T;
  }
}

// 仅 mock 本测试关心的 decideApproval。
vi.mock("@/lib/api", () => ({
  decideApproval: vi.fn(),
}));

const decideApprovalMock = vi.mocked(api.decideApproval);

// 默认 lang 为 en；断言统一取 copy.en。
const t = copy.en;

/** 在应用 Provider 中渲染 ApprovalList（依赖 useI18n + next-themes）。 */
function renderList() {
  return render(
    <ThemeProvider>
      <I18nProvider>
        <ApprovalList />
      </I18nProvider>
    </ThemeProvider>,
  );
}

// jsdom 不实现 matchMedia；next-themes 依赖它，提供最小桩件。
beforeAll(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: false,
      media: "",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    }),
  );
});

// 每个用例前 reset store 与 mock；播种一条审批；默认 resolve 一个带 result 的返回。
beforeEach(() => {
  useChatStore.getState().reset();
  useChatStore.getState().pushApproval({
    approvalId: "ap-1",
    message: "Run `rm -rf build`?",
    command: "rm -rf build",
    commandHash: "hash-1",
  });
  decideApprovalMock.mockReset();
  decideApprovalMock.mockResolvedValue({
    result: { exitCode: 0, stdout: "done", stderr: "" },
  });
});

describe("ApprovalList", () => {
  // 渲染审批消息 + 批准/拒绝按钮。
  it("renders the approval message with Approve/Reject buttons", () => {
    renderList();

    expect(screen.getByText("Run `rm -rf build`?")).toBeInTheDocument();
    expect(screen.getByText("rm -rf build")).toBeInTheDocument();
    expect(screen.getByText("sha256:hash-1")).toBeInTheDocument();
    // 按钮以 aria-label（动作 + 消息上下文）命名。
    expect(
      screen.getByRole("button", { name: `${t.approve}: Run \`rm -rf build\`?` }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: `${t.reject}: Run \`rm -rf build\`?` }),
    ).toBeInTheDocument();
  });

  // 点击批准：调用 API、移除审批、追加 runtime 转录消息 + 运行事件。
  it("approves: calls decideApproval, removes the approval, appends transcript + runtime event", async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(
      screen.getByRole("button", { name: `${t.approve}: Run \`rm -rf build\`?` }),
    );

    // 调用了带 "approve" 决策的 API。
    await waitFor(() =>
      expect(decideApprovalMock).toHaveBeenCalledWith("ap-1", "approve", "hash-1"),
    );

    const s = useChatStore.getState();
    // 审批从队列移除。
    expect(s.approvals).toHaveLength(0);
    // 推了一条运行事件标记。
    expect(s.runtimeEvents).toContain("approval approve: ap-1");
    // 追加了一条 runtime 转录消息，含 exit code 与 stdout。
    const runtimeMsg = s.messages.find((m) => m.role === "runtime");
    expect(runtimeMsg).toBeDefined();
    expect(runtimeMsg!.text).toContain("approval result: exit 0");
    expect(runtimeMsg!.text).toContain("stdout:\ndone");
  });

  // 点击拒绝：调用带 "reject" 决策的 API 并移除审批。
  it("rejects: calls decideApproval with reject and removes the approval", async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(
      screen.getByRole("button", { name: `${t.reject}: Run \`rm -rf build\`?` }),
    );

    await waitFor(() =>
      expect(decideApprovalMock).toHaveBeenCalledWith("ap-1", "reject", "hash-1"),
    );
    expect(useChatStore.getState().approvals).toHaveLength(0);
  });

  // 点击拒绝：旧审批事件可能没有 commandHash，拒绝路径仍应能失败闭合。
  it("rejects an approval even when the command hash is missing", async () => {
    useChatStore.getState().reset();
    useChatStore.getState().pushApproval({
      approvalId: "ap-no-hash",
      message: "Run unknown command?",
      command: "unknown command",
    });
    const user = userEvent.setup();
    renderList();

    await user.click(
      screen.getByRole("button", { name: `${t.reject}: Run unknown command?` }),
    );

    await waitFor(() =>
      expect(decideApprovalMock).toHaveBeenCalledWith(
        "ap-no-hash",
        "reject",
        undefined,
      ),
    );
    expect(useChatStore.getState().approvals).toHaveLength(0);
  });

  // busy-guard：决策飞行中（promise 未 resolve）应禁用本卡片的批准/拒绝按钮，
  // 决策 settle 后审批被移除、按钮随卡片消失。
  it("disables the approve/reject buttons while a decision is in flight", async () => {
    // 用一个手动可控的 deferred promise 卡住 decideApproval，模拟飞行中状态。
    let resolveDecision!: (value: { result?: unknown }) => void;
    decideApprovalMock.mockReset();
    decideApprovalMock.mockReturnValue(
      new Promise((resolve) => {
        resolveDecision = resolve as (value: { result?: unknown }) => void;
      }),
    );

    const user = userEvent.setup();
    renderList();

    const approveBtn = screen.getByRole("button", {
      name: `${t.approve}: Run \`rm -rf build\`?`,
    });
    const rejectBtn = screen.getByRole("button", {
      name: `${t.reject}: Run \`rm -rf build\`?`,
    });

    // 点击批准：进入 deciding 态，但 promise 仍未 resolve。
    await user.click(approveBtn);

    // 飞行中：两个按钮都应被禁用（busy → disabled）。
    await waitFor(() => expect(approveBtn).toBeDisabled());
    expect(rejectBtn).toBeDisabled();
    // 审批尚未移除（decide 的 removeApproval 在 resolve 之后才执行）。
    expect(useChatStore.getState().approvals).toHaveLength(1);

    // resolve 决策：审批被移除，卡片连同按钮一并卸载。
    resolveDecision({ result: undefined });
    await waitFor(() => expect(useChatStore.getState().approvals).toHaveLength(0));
    expect(
      screen.queryByRole("button", { name: `${t.approve}: Run \`rm -rf build\`?` }),
    ).not.toBeInTheDocument();
  });

  // 容器暴露 aria-live + aria-label（修复审计「approvals not announced」）。
  it("exposes an aria-live container labelled by the approvals heading", () => {
    renderList();
    const region = screen.getByLabelText(t.approvals);
    expect(region).toHaveAttribute("aria-live");
    expect(region.getAttribute("aria-live")).toMatch(/assertive|polite/);
  });

  // axe：审批卡片（含按钮）零无障碍违规。
  it("has no axe violations", async () => {
    const { container } = renderList();
    expect(await axe(container)).toHaveNoViolations();
  });
});
