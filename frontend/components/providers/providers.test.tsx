// frontend/components/providers/providers.test.tsx
// Provider 组件测试：验证 I18nProvider 的语言切换、文案解析与越界使用保护，
// 以及 ThemeProvider 能在不崩溃的前提下渲染子节点。

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider, useI18n } from "./I18nProvider";
import { ThemeProvider } from "./ThemeProvider";
import { copy } from "@/lib/i18n";

/** localStorage 持久化偏好的键（与 I18nProvider 内常量保持一致）。 */
const STORAGE_KEY = "kodeks.ui.language";

/**
 * 安装一个内存版 localStorage 桩件。
 * jsdom 在本环境下未提供 window.localStorage，I18nProvider 以 try/catch 守卫；
 * 测试持久化路径必须显式注入可用实现。返回内部存储以便断言写入结果。
 * @param seed 预置的键值对（模拟「上次会话已写入偏好」）。
 */
function stubLocalStorage(seed: Record<string, string> = {}) {
  const store: Record<string, string> = { ...seed };
  const ls = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      for (const k in store) delete store[k];
    },
  };
  vi.stubGlobal("localStorage", ls);
  return store;
}

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
  // jsdom 的 navigator.language 默认值；system 解析用例会临时覆盖，afterEach 复原。
  const ORIGINAL_NAV_LANG = navigator.language;

  // 每个用例后撤销 localStorage 桩件并复原 navigator.language，避免泄漏到后续用例。
  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(navigator, "language", {
      value: ORIGINAL_NAV_LANG,
      configurable: true,
    });
  });

  // 持久化读取：预置 localStorage 偏好为 "zh"，挂载后应解析并渲染中文文案。
  it("reads a persisted zh preference from localStorage on mount", async () => {
    stubLocalStorage({ [STORAGE_KEY]: "zh" });
    render(
      <I18nProvider>
        <Consumer />
      </I18nProvider>,
    );

    // 偏好读取发生在挂载后的 effect 中，故用 waitFor 等待文案校正为中文。
    await waitFor(() =>
      expect(screen.getByTestId("copy")).toHaveTextContent(copy.zh.send),
    );
  });

  // 持久化写入 + html lang：setPreference("zh") 应写入 localStorage 并同步 <html lang>。
  it("persists the preference and syncs document.documentElement.lang", async () => {
    const store = stubLocalStorage();
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <Consumer />
      </I18nProvider>,
    );

    await user.click(screen.getByRole("button", { name: "to-zh" }));

    // 偏好写入持久化存储。
    expect(store[STORAGE_KEY]).toBe("zh");
    // html-lang effect 在挂载后运行，故等待 <html lang> 校正为 zh。
    await waitFor(() =>
      expect(document.documentElement.lang).toBe("zh"),
    );
  });

  // system 解析：偏好为 system 且设备语言为 zh-CN 时，应解析为中文。
  it("resolves a system preference to zh when navigator.language is zh-CN", async () => {
    // 设备语言桩为 zh-CN；localStorage 缺省偏好（system）。
    Object.defineProperty(navigator, "language", {
      value: "zh-CN",
      configurable: true,
    });
    stubLocalStorage();
    render(
      <I18nProvider>
        <Consumer />
      </I18nProvider>,
    );

    // system → resolveLanguage("zh-CN") → "zh"，文案应为中文。
    await waitFor(() =>
      expect(screen.getByTestId("copy")).toHaveTextContent(copy.zh.send),
    );
  });

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
