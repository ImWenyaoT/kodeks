// frontend/components/providers/providers.test.tsx
// Provider 组件测试：验证 I18nProvider 的语言切换、文案解析与越界使用保护，
// 以及 ThemeProvider 能在不崩溃的前提下渲染子节点。

import { describe, it, expect, beforeAll, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider, useI18n } from "./I18nProvider";
import { ThemeProvider } from "./ThemeProvider";
import { copy } from "@/lib/i18n";

/**
 * 测试消费组件：展示当前语言的 `send` 文案，并提供切换到 en/zh 的按钮。
 */
function Consumer() {
  const { t, setPreference } = useI18n();
  return (
    <div>
      <span data-testid="copy">{t.send}</span>
      <button onClick={() => setPreference("en")}>to-en</button>
      <button onClick={() => setPreference("zh")}>to-zh</button>
    </div>
  );
}

describe("I18nProvider", () => {
  // setPreference 切换偏好后，显示的文案应在 en / zh 字符串之间切换。
  it("switches displayed copy when preference changes", async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <Consumer />
      </I18nProvider>,
    );

    // 切到英文：显示英文 `send` 文案。
    await user.click(screen.getByRole("button", { name: "to-en" }));
    expect(screen.getByTestId("copy")).toHaveTextContent(copy.en.send);

    // 切到中文：显示中文 `send` 文案（与英文不同，确保确实切换了）。
    await user.click(screen.getByRole("button", { name: "to-zh" }));
    expect(screen.getByTestId("copy")).toHaveTextContent(copy.zh.send);
    expect(copy.zh.send).not.toBe(copy.en.send);
  });

  // useI18n 在 Provider 之外使用必须抛错，尽早暴露接线问题。
  it("throws when useI18n is used outside the provider", () => {
    function Orphan() {
      useI18n();
      return null;
    }
    // 抑制 React 把渲染错误打到 console 的噪音不是必须的；断言抛错即可。
    expect(() => render(<Orphan />)).toThrow(/within an <I18nProvider>/);
  });
});

describe("ThemeProvider", () => {
  // jsdom 不实现 matchMedia，而 next-themes 依赖它探测系统外观；提供最小桩件。
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

  // 仅冒烟测试：能渲染子节点而不崩溃（jsdom 下不深究 class 切换）。
  it("renders children without crashing", () => {
    render(
      <ThemeProvider>
        <span data-testid="child">ok</span>
      </ThemeProvider>,
    );
    expect(screen.getByTestId("child")).toHaveTextContent("ok");
  });
});
