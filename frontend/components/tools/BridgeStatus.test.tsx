// frontend/components/tools/BridgeStatus.test.tsx
// MoonBridge 预检状态卡片（Task 4.7）测试：
//   1. 预检成功（ready）→ 卡片显示 ready 标题及明细行（provider/upstream/model）；
//   2. 预检失败（reject）→ 卡片落到 unavailable 标题，并展示错误原因；
//   3. 点击刷新按钮 → 再次调用 bridgePreflight（调用次数增加）；
//   4. axe(container) 零无障碍违规。
// 通过 mock @/lib/api 的 bridgePreflight 隔离网络；matchMedia 桩件供 next-themes；
// 渲染前在 store 写入一个 model（hook 监听 store.model 才会发起预检）；每个用例前 reset store。

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";

import { BridgeStatus } from "./BridgeStatus";
import { I18nProvider } from "@/components/providers/I18nProvider";
import { ThemeProvider } from "@/components/providers/ThemeProvider";
import { useChatStore } from "@/stores/chat-store";
import { copy } from "@/lib/i18n";
import type { BridgePreflight } from "@/lib/api";
import * as api from "@/lib/api";

// vitest-axe 的类型增强（运行期匹配器在 test/setup.ts 注册）。
declare module "@vitest/expect" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Matchers<T = any> {
    toHaveNoViolations(): T;
  }
}

// 仅 mock 本测试关心的 bridgePreflight。
vi.mock("@/lib/api", () => ({
  bridgePreflight: vi.fn(),
}));

const bridgePreflightMock = vi.mocked(api.bridgePreflight);

// 默认 lang 为 en；断言统一取 copy.en。
const t = copy.en;

// 成功用例的预检返回：ready + provider/upstream/model 明细。
const READY: BridgePreflight = {
  status: "ready",
  resolvedProvider: "deepseek",
  upstreamBaseURL: "https://api.deepseek.com",
  upstreamModel: "deepseek-v4-pro",
};

/** 在应用 Provider 中渲染 BridgeStatus（依赖 useI18n + next-themes）。 */
function renderCard() {
  return render(
    <ThemeProvider>
      <I18nProvider>
        <BridgeStatus />
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

// 每个用例前 reset store 与 mock；写入一个 model 以触发 hook 的预检 effect。
beforeEach(() => {
  useChatStore.getState().reset();
  useChatStore.getState().setSettings({ model: "deepseek/deepseek-v4-pro" });
  bridgePreflightMock.mockReset();
  bridgePreflightMock.mockResolvedValue(structuredClone(READY));
});

describe("BridgeStatus", () => {
  // 预检成功：显示 ready 标题与明细行。
  it("shows the ready title and detail rows after preflight resolves", async () => {
    renderCard();

    // 效果解析后出现 ready 标题。
    expect(await screen.findByText(t.ready)).toBeInTheDocument();

    // 明细行：resolvedProvider / upstreamBaseURL / upstreamModel 各自呈现。
    expect(screen.getByText("deepseek")).toBeInTheDocument();
    expect(screen.getByText("https://api.deepseek.com")).toBeInTheDocument();
    expect(screen.getByText("deepseek-v4-pro")).toBeInTheDocument();
  });

  // 预检失败：落到 unavailable 标题。
  it("shows the unavailable title when preflight rejects", async () => {
    bridgePreflightMock.mockReset();
    bridgePreflightMock.mockRejectedValue(new Error("boom"));

    renderCard();

    expect(await screen.findByText(t.unavailable)).toBeInTheDocument();
    // reason 来自错误消息。
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  // 点击刷新：再次发起预检（调用次数增加）。
  it("re-runs preflight when the refresh button is clicked", async () => {
    const user = userEvent.setup();
    renderCard();

    // 首次预检完成（计数 1）。
    await waitFor(() => expect(bridgePreflightMock).toHaveBeenCalledTimes(1));

    // 点刷新按钮（以 aria-label 命名）。
    await user.click(screen.getByRole("button", { name: t.refresh }));

    // 计数增加到 2。
    await waitFor(() => expect(bridgePreflightMock).toHaveBeenCalledTimes(2));
  });

  // axe：卡片（含状态区与明细）零无障碍违规。
  it("has no axe violations", async () => {
    const { container } = renderCard();
    await screen.findByText(t.ready);
    expect(await axe(container)).toHaveNoViolations();
  });
});
