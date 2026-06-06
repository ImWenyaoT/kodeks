// frontend/components/tools/RuntimeEvents.test.tsx
// 运行事件流 + 概要（Task 4.8）测试：
//   1. 播种 runtimeEvents → 以「最新在前」倒序渲染；
//   2. 概要行显示事件计数与会话标识；
//   3. 事件流容器为 aria-live="polite"；
//   4. axe(container) 零无障碍违规。
// matchMedia 桩件供 next-themes；每个用例前 reset store 并播种数据。

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { axe } from "vitest-axe";

import { RuntimeEvents } from "./RuntimeEvents";
import { I18nProvider } from "@/components/providers/I18nProvider";
import { ThemeProvider } from "@/components/providers/ThemeProvider";
import { useChatStore } from "@/stores/chat-store";
import { copy } from "@/lib/i18n";

// vitest-axe 的类型增强（运行期匹配器在 test/setup.ts 注册）。
declare module "@vitest/expect" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Matchers<T = any> {
    toHaveNoViolations(): T;
  }
}

// 默认 lang 为 en；断言统一取 copy.en。
const t = copy.en;

/** 在应用 Provider 中渲染 RuntimeEvents（依赖 useI18n + next-themes）。 */
function renderFeed() {
  return render(
    <ThemeProvider>
      <I18nProvider>
        <RuntimeEvents />
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

// 每个用例前 reset store。
beforeEach(() => {
  useChatStore.getState().reset();
});

describe("RuntimeEvents", () => {
  // 播种事件 → 以「最新在前」倒序渲染。
  it("renders runtime events newest-first", () => {
    useChatStore.getState().pushRuntime("first event");
    useChatStore.getState().pushRuntime("second event");
    useChatStore.getState().pushRuntime("third event");

    renderFeed();

    const items = screen.getAllByRole("listitem");
    // store 追加为 first→second→third；展示倒序：third 在最前、first 在最后。
    expect(items[0]).toHaveTextContent("third event");
    expect(items[1]).toHaveTextContent("second event");
    expect(items[2]).toHaveTextContent("first event");
  });

  // 概要行显示事件计数与会话标识。
  it("shows the event count and session in the summary", () => {
    useChatStore.getState().pushRuntime("evt-a");
    useChatStore.getState().pushRuntime("evt-b");
    useChatStore.getState().setSession("sess-42");

    renderFeed();

    // 计数以无障碍标签命名。
    expect(
      screen.getByLabelText(`${t.runtimeEvents}: 2`),
    ).toBeInTheDocument();
    // 会话标识出现在概要中。
    expect(screen.getByText(/sess-42/)).toBeInTheDocument();
  });

  // 会话为空时概要回退到自动会话文案。
  it("falls back to the auto-session label when no session is set", () => {
    renderFeed();
    expect(screen.getByText(new RegExp(t.autoSession))).toBeInTheDocument();
  });

  // 事件流容器为 aria-live="polite"（修复审计「runtime updates not announced」）。
  it("exposes a polite aria-live feed labelled by the activity heading", () => {
    renderFeed();
    const region = screen.getByLabelText(t.activity);
    expect(region).toHaveAttribute("aria-live", "polite");
  });

  // axe：概要 + 事件流零无障碍违规。
  it("has no axe violations", async () => {
    useChatStore.getState().pushRuntime("evt");
    const { container } = renderFeed();
    expect(await axe(container)).toHaveNoViolations();
  });
});
