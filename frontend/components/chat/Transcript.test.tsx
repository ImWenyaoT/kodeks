// frontend/components/chat/Transcript.test.tsx
// 对话转录区（Task 4.2）测试：
//   1. 空 store → 渲染欢迎语（t.welcome）；
//   2. 填充 user + assistant 消息并对助手追加 delta → 两条气泡均渲染，
//      且助手文本反映流式拼接后的内容；
//   3. 滚动容器暴露 live region 属性 role="log" + aria-live="polite"；
//   4. axe 无障碍检查零违规。
// 每个用例前 reset store，避免跨用例的状态泄漏。

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { axe } from "vitest-axe";

import { Transcript } from "./Transcript";
import { I18nProvider } from "@/components/providers/I18nProvider";
import { ThemeProvider } from "@/components/providers/ThemeProvider";
import { useChatStore } from "@/stores/chat-store";
import { copy } from "@/lib/i18n";

// vitest-axe 的全局类型增强面向旧版命名空间；Vitest 4 用 @vitest/expect 的
// Matchers<T> 接口承载自定义匹配器。补一条声明合并让 toHaveNoViolations 类型可见
// （运行期匹配器已由 test/setup.ts 注册）。
declare module "@vitest/expect" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Matchers<T = any> {
    toHaveNoViolations(): T;
  }
}

/**
 * 在应用 Provider 中渲染 Transcript。
 * Transcript 依赖 useI18n（需 I18nProvider）；ThemeProvider 一并包裹贴近真实环境。
 * jsdom 下 navigator.language 非 zh，默认语言解析为 en。
 */
function renderTranscript() {
  return render(
    <ThemeProvider>
      <I18nProvider>
        <Transcript />
      </I18nProvider>
    </ThemeProvider>,
  );
}

// jsdom 不实现 matchMedia；next-themes 与潜在媒体查询读取都依赖它，提供最小桩件。
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

// 每个用例前清空 store 的运行态（保留 settings），避免状态在用例间泄漏。
beforeEach(() => {
  useChatStore.getState().reset();
});

describe("Transcript", () => {
  // 空 store：应渲染欢迎语作为引导（assistant 样式气泡）。
  it("renders the welcome message when there are no messages", () => {
    renderTranscript();
    expect(screen.getByText(copy.en.welcome)).toBeInTheDocument();
  });

  // 填充 user + assistant 消息并对助手追加 delta：两条气泡均渲染，
  // 助手文本反映流式拼接结果，欢迎语不再显示。
  it("renders user and assistant bubbles with streamed assistant text", () => {
    const store = useChatStore.getState();
    store.appendMessage("user", "Refactor this file");
    const assistantId = store.appendMessage("assistant", "Sure, ");
    // 模拟流式增量：追加 delta 到助手消息末尾。
    store.appendDelta(assistantId, "working on it.");

    renderTranscript();

    // 用户气泡。
    expect(screen.getByText("Refactor this file")).toBeInTheDocument();
    // 助手气泡：流式拼接后的完整文本。
    expect(screen.getByText("Sure, working on it.")).toBeInTheDocument();
    // 有消息后不再展示空态欢迎语。
    expect(screen.queryByText(copy.en.welcome)).not.toBeInTheDocument();
  });

  // live region：滚动容器应暴露 role="log" + aria-live="polite"，
  // 使流式文本与新消息对屏幕阅读器可播报（P0 审计修复）。
  it("exposes the transcript container as a polite live region", () => {
    renderTranscript();
    const log = screen.getByRole("log", { name: copy.en.transcript });
    expect(log).toHaveAttribute("aria-live", "polite");
    expect(log).toHaveAttribute("aria-relevant", "additions text");
  });

  // axe：渲染结果零无障碍违规。
  it("has no axe violations", async () => {
    const store = useChatStore.getState();
    store.appendMessage("user", "Hello");
    store.appendMessage("assistant", "Hi there");
    store.appendMessage("runtime", "tool: read_file");

    const { container } = renderTranscript();
    expect(await axe(container)).toHaveNoViolations();
  });
});
