// frontend/components/workspace/FilePicker.test.tsx
// 工作区文件选择器（Task 4.5）测试：
//   1. 展开 picker（点「选择文件」切换按钮）触发 getWorkspaceFiles 并列出文件；
//      收起后再次展开不重新请求（mock 恰好被调用一次，命中懒加载缓存）；
//   2. 在搜索框输入关键字 → 可见列表按不区分大小写子串过滤；
//   3. 勾选某文件 checkbox → 调用 toggleFile，store.selectedFiles 更新，且 checkbox 反映选中态；
//   4. 选中后摘要行展示已选数量（t.selectedFileCount）；
//   5. axe 无障碍检查零违规（picker 无 overlay，直接 axe(container) 即可）。
// 通过 mock @/lib/api 的 getWorkspaceFiles 隔离网络；每个用例前 reset store。

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";

import { FilePicker } from "./FilePicker";
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

// 把 api 模块整体 mock：仅 getWorkspaceFiles 是本测试关心的方法。
vi.mock("@/lib/api", () => ({
  getWorkspaceFiles: vi.fn(),
}));

const getWorkspaceFilesMock = vi.mocked(api.getWorkspaceFiles);

// 默认 lang 为 en，断言文案统一取 copy.en，避免语言切换带来歧义。
const t = copy.en;

// 测试用文件列表：含多级路径与大小写混合，覆盖过滤与无障碍命名。
const FILES = ["a.ts", "b/c.py", "README.md"];

/**
 * 在应用 Provider 中渲染 FilePicker。
 * 依赖 useI18n（需 I18nProvider）；ThemeProvider 一并包裹贴近真实环境。
 */
function renderPicker() {
  return render(
    <ThemeProvider>
      <I18nProvider>
        <FilePicker />
      </I18nProvider>
    </ThemeProvider>,
  );
}

/** 取「选择文件」切换按钮（可见文字即其无障碍名）。 */
function getToggle() {
  return screen.getByRole("button", { name: new RegExp(t.selectFiles) });
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
  getWorkspaceFilesMock.mockReset();
  getWorkspaceFilesMock.mockResolvedValue([...FILES]);
});

describe("FilePicker", () => {
  // 展开触发懒加载并列出文件；收起后再次展开命中缓存，不重新请求（恰好一次）。
  it("lazy-loads files on first open and caches across toggles", async () => {
    const user = userEvent.setup();
    renderPicker();

    // 折叠态：尚未请求，文件不可见。
    expect(getWorkspaceFilesMock).not.toHaveBeenCalled();

    // 第一次展开：触发 fetch，三个文件全部以 checkbox 列出。
    await user.click(getToggle());
    expect(await screen.findByRole("checkbox", { name: "a.ts" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "b/c.py" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "README.md" })).toBeInTheDocument();
    expect(getWorkspaceFilesMock).toHaveBeenCalledTimes(1);

    // 收起：列表卸载（搜索框消失）。
    await user.click(getToggle());
    await waitFor(() =>
      expect(screen.queryByRole("checkbox", { name: "a.ts" })).not.toBeInTheDocument(),
    );

    // 再次展开：命中缓存，列表立即回显，且 mock 仍只被调用过一次。
    await user.click(getToggle());
    expect(await screen.findByRole("checkbox", { name: "a.ts" })).toBeInTheDocument();
    expect(getWorkspaceFilesMock).toHaveBeenCalledTimes(1);
  });

  // 搜索框输入关键字 → 可见列表做不区分大小写的子串过滤。
  it("filters the visible list as the user types", async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(getToggle());
    await screen.findByRole("checkbox", { name: "a.ts" });

    // 输入大写 README（验证不区分大小写）：仅保留 README.md。
    const search = screen.getByRole("searchbox", { name: t.filePlaceholder });
    await user.type(search, "README");

    expect(screen.getByRole("checkbox", { name: "README.md" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "a.ts" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "b/c.py" })).not.toBeInTheDocument();
  });

  // 勾选某文件 → 调用 toggleFile，store.selectedFiles 更新，checkbox 反映选中态。
  it("toggles selection into the store and reflects checked state", async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(getToggle());
    const checkbox = await screen.findByRole("checkbox", { name: "b/c.py" });

    // 初始未选。
    expect(checkbox).not.toBeChecked();
    expect(useChatStore.getState().selectedFiles.has("b/c.py")).toBe(false);

    // 勾选：store 收录该路径，checkbox 变为选中。
    await user.click(checkbox);
    expect(useChatStore.getState().selectedFiles.has("b/c.py")).toBe(true);
    expect(checkbox).toBeChecked();

    // 再次点击：取消选择，store 移除，checkbox 复位。
    await user.click(checkbox);
    expect(useChatStore.getState().selectedFiles.has("b/c.py")).toBe(false);
    expect(checkbox).not.toBeChecked();
  });

  // 选中后摘要行展示已选数量（t.selectedFileCount）。
  it("shows the selected count summary after a selection", async () => {
    const user = userEvent.setup();
    renderPicker();

    // 初始摘要：尚未选择。
    expect(screen.getByText(t.noFilesSelected)).toBeInTheDocument();

    await user.click(getToggle());
    const checkbox = await screen.findByRole("checkbox", { name: "a.ts" });
    await user.click(checkbox);

    // 选中一项后，摘要切换为「1 file selected」。
    expect(screen.getByText(t.selectedFileCount(1))).toBeInTheDocument();
    expect(screen.queryByText(t.noFilesSelected)).not.toBeInTheDocument();
  });

  // axe：picker 展开（含文件列表）零无障碍违规。
  it("has no axe violations with the picker open", async () => {
    const user = userEvent.setup();
    const { container } = renderPicker();

    await user.click(getToggle());
    await screen.findByRole("checkbox", { name: "a.ts" });

    expect(await axe(container)).toHaveNoViolations();
  });

  // 兜底：确保展开后搜索框与列表共处一个 panel（aria-controls 关联的容器内）。
  it("renders search and results inside the toggle's controlled panel", async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(getToggle());
    await screen.findByRole("checkbox", { name: "a.ts" });

    const panelId = getToggle().getAttribute("aria-controls");
    expect(panelId).toBeTruthy();
    const panel = document.getElementById(panelId!);
    expect(panel).not.toBeNull();
    expect(
      within(panel!).getByRole("searchbox", { name: t.filePlaceholder }),
    ).toBeInTheDocument();
    expect(
      within(panel!).getByRole("checkbox", { name: "a.ts" }),
    ).toBeInTheDocument();
  });
});
