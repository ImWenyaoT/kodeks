// frontend/components/workspace/SessionList.test.tsx
// 最近会话列表（Task 4.4）测试：
//   1. getSessions 返回 2 条 → 加载后两个标题都渲染；
//   2. 空列表 → 展示 t.noSessions 空状态；
//   3. 点击某行 → 调用 getSession(id)，并把历史转录灌入 store（messages 与 sessionId）；
//   4. axe 无障碍检查零违规。
// 通过 mock @/lib/api 的 getSessions / getSession 隔离网络；每个用例前 reset store。

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";

import { SessionList } from "./SessionList";
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

// 把 api 模块整体 mock：仅 getSessions / getSession 是本测试关心的方法。
vi.mock("@/lib/api", () => ({
  getSessions: vi.fn(),
  getSession: vi.fn(),
}));

const getSessionsMock = vi.mocked(api.getSessions);
const getSessionMock = vi.mocked(api.getSession);

/**
 * 在应用 Provider 中渲染 SessionList。
 * 依赖 useI18n（需 I18nProvider）；ThemeProvider 一并包裹贴近真实环境。
 */
function renderList() {
  return render(
    <ThemeProvider>
      <I18nProvider>
        <SessionList />
      </I18nProvider>
    </ThemeProvider>,
  );
}

// jsdom 不实现 matchMedia；next-themes 等依赖它，提供最小桩件。
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

// 每个用例前清空 store 与 mock，复位默认返回值，避免状态/调用在用例间泄漏。
beforeEach(() => {
  useChatStore.getState().reset();
  getSessionsMock.mockReset();
  getSessionMock.mockReset();
});

describe("SessionList", () => {
  // 两条会话：加载完成后两个标题都应渲染。
  it("renders session titles after load", async () => {
    getSessionsMock.mockResolvedValue([
      { id: "s1", title: "Refactor parser", mode: "act", updatedAt: "2026-06-06T10:00:00Z" },
      { id: "s2", title: "Plan migration", mode: "plan", updatedAt: "2026-06-05T09:00:00Z" },
    ]);
    renderList();

    expect(await screen.findByText("Refactor parser")).toBeInTheDocument();
    expect(screen.getByText("Plan migration")).toBeInTheDocument();
  });

  // 空列表：展示 t.noSessions 空状态文案。
  it("shows the empty state when there are no sessions", async () => {
    getSessionsMock.mockResolvedValue([]);
    renderList();

    expect(await screen.findByText(copy.en.noSessions)).toBeInTheDocument();
  });

  // 点击某行：调用 getSession(id)，并把历史转录灌入 store（含 sessionId）。
  it("hydrates the store when a row is clicked", async () => {
    getSessionsMock.mockResolvedValue([
      { id: "s1", title: "Refactor parser", mode: "act" },
    ]);
    getSessionMock.mockResolvedValue({
      session: { id: "s1" },
      messages: [
        { id: "m1", sessionId: "s1", role: "user", content: "Fix the bug" },
        { id: "m2", sessionId: "s1", role: "assistant", content: "Done." },
        // runtime 角色不应进入气泡转录。
        { id: "m3", sessionId: "s1", role: "runtime", content: "tool_call" },
      ],
    });
    const user = userEvent.setup();
    renderList();

    const row = await screen.findByRole("button", { name: /Refactor parser/ });
    await user.click(row);

    await waitFor(() => {
      expect(getSessionMock).toHaveBeenCalledWith("s1");
      const state = useChatStore.getState();
      expect(state.sessionId).toBe("s1");
      expect(state.messages).toHaveLength(2);
      expect(state.messages[0]).toMatchObject({ role: "user", text: "Fix the bug" });
      expect(state.messages[1]).toMatchObject({ role: "assistant", text: "Done." });
    });
  });

  // axe：渲染结果（含一行会话）零无障碍违规。
  it("has no axe violations", async () => {
    getSessionsMock.mockResolvedValue([
      { id: "s1", title: "Refactor parser", mode: "act", updatedAt: "2026-06-06T10:00:00Z" },
    ]);
    const { container } = renderList();
    await screen.findByText("Refactor parser");

    expect(await axe(container)).toHaveNoViolations();
  });
});
