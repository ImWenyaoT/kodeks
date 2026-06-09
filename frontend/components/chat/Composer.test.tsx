// frontend/components/chat/Composer.test.tsx
// 消息输入区（Task 4.3）测试：
//   1. 输入文本启用发送按钮；为空时保持 disabled；
//   2. Enter 调用 send（传入所输入文本）；Shift+Enter 不提交（仅换行）；
//   3. isRunning 为 true 时展示「停止」控件、点击调用 stop，且发送按钮带 aria-busy；
//   4. store 中的已选文件渲染为 chip，点击调用 toggleFile；
//   5. axe 无障碍检查零违规。
// 通过 mock @/hooks/useChatStream 捕获 send/stop 并以变量控制 isRunning。
// 每个用例前 reset store，避免跨用例状态泄漏。

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";

import { Composer } from "./Composer";
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

// useChatStream 的 mock 句柄：测试用例可改写 isRunning 并断言 send/stop 调用。
const sendMock = vi.fn();
const stopMock = vi.fn();
let isRunningMock = false;

// 把 hook 替换为返回受控对象的桩件，避免触达真实网络/SSE 逻辑。
vi.mock("@/hooks/useChatStream", () => ({
  useChatStream: () => ({
    send: sendMock,
    stop: stopMock,
    isRunning: isRunningMock,
  }),
}));

/**
 * 在应用 Provider 中渲染 Composer。
 * Composer 依赖 useI18n（需 I18nProvider）；ThemeProvider 一并包裹贴近真实环境。
 */
function renderComposer() {
  return render(
    <ThemeProvider>
      <I18nProvider>
        <Composer />
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

// 每个用例前清空 store 与 mock 句柄、复位运行态，避免状态在用例间泄漏。
beforeEach(() => {
  useChatStore.getState().reset();
  sendMock.mockClear();
  stopMock.mockClear();
  isRunningMock = false;
});

describe("Composer", () => {
  // 空输入：发送按钮 disabled；键入文本后启用。
  it("disables send while empty and enables it once text is typed", async () => {
    const user = userEvent.setup();
    renderComposer();

    const send = screen.getByRole("button", { name: copy.en.send });
    expect(send).toBeDisabled();

    await user.type(screen.getByRole("textbox"), "Refactor this file");
    expect(send).toBeEnabled();
  });

  // Enter 提交：调用 send 且实参为所输入文本。
  it("submits on Enter with the typed text", async () => {
    const user = userEvent.setup();
    renderComposer();

    await user.type(screen.getByRole("textbox"), "Hello there");
    await user.keyboard("{Enter}");

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith("Hello there");
  });

  // Shift+Enter 换行：不提交（send 不被调用），文本保留换行。
  it("does not submit on Shift+Enter", async () => {
    const user = userEvent.setup();
    renderComposer();

    const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;
    await user.type(textbox, "line one");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    await user.type(textbox, "line two");

    expect(sendMock).not.toHaveBeenCalled();
    expect(textbox.value).toContain("\n");
  });

  // 运行中：展示「停止」控件、点击调用 stop；发送按钮带 aria-busy。
  it("shows a Stop control while running and marks send as busy", async () => {
    isRunningMock = true;
    const user = userEvent.setup();
    renderComposer();

    const stop = screen.getByRole("button", { name: copy.en.stop });
    await user.click(stop);
    expect(stopMock).toHaveBeenCalledTimes(1);

    const send = screen.getByRole("button", { name: copy.en.send });
    expect(send).toHaveAttribute("aria-busy", "true");
  });

  // 已选文件：store 中的文件渲染为可点击 chip，点击调用 toggleFile 移除它。
  it("renders a chip for a selected file and removes it on click", async () => {
    useChatStore.getState().toggleFile("src/index.ts");
    const user = userEvent.setup();
    renderComposer();

    const chip = screen.getByRole("button", { name: /Remove file: src\/index\.ts/ });
    await user.click(chip);

    // toggleFile 已把该路径移出选择。
    expect(useChatStore.getState().selectedFiles.has("src/index.ts")).toBe(false);
  });

  // axe：渲染结果零无障碍违规（含一个已选文件 chip 以覆盖 chip 路径）。
  it("has no axe violations", async () => {
    useChatStore.getState().toggleFile("src/index.ts");
    const { container } = renderComposer();
    expect(await axe(container)).toHaveNoViolations();
  });
});
