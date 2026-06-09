// frontend/app/page.test.tsx
// 工作区外壳（Shell / page）测试：
//   1. 渲染三个语义 landmark 区域（一个 <main> + 两个 <aside>，以及分区标题）；
//   2. 点击左侧“收起/展开”控制可切换 rail ↔ panel 的可见状态；
//   3. axe 无障碍检查在渲染结果上零违规。
// 与 providers.test.tsx 一致：jsdom 缺 matchMedia，于 beforeAll 打桩，避免
// ThemeProvider / 组件读取时崩溃。

import { describe, it, expect, beforeAll, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";

import Home from "./page";
import { I18nProvider } from "@/components/providers/I18nProvider";
import { ThemeProvider } from "@/components/providers/ThemeProvider";
import { copy } from "@/lib/i18n";

// vitest-axe 自带的全局类型增强面向旧版 `Vi.Assertion` 命名空间，Vitest 4 改用
// `@vitest/expect` 的 `Matchers<T>` 接口承载自定义匹配器。此处补一条针对新接口
// 的声明合并，让 `toHaveNoViolations` 在断言上类型可见（运行期匹配器已由
// test/setup.ts 注册）。
declare module "@vitest/expect" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Matchers<T = any> {
    toHaveNoViolations(): T;
  }
}

/**
 * 在应用 Provider 中渲染首页。
 * Shell 内部依赖 useI18n（需 I18nProvider）；ThemeProvider 一并包裹以贴近真实
 * 渲染环境。默认语言解析为 en（jsdom 下 navigator.language 非 zh）。
 */
function renderShell() {
  return render(
    <ThemeProvider>
      <I18nProvider>
        <Home />
      </I18nProvider>
    </ThemeProvider>,
  );
}

// jsdom 不实现 matchMedia；next-themes 与潜在的媒体查询读取都依赖它。
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

describe("Workspace Shell (page)", () => {
  // landmark：一个 main + 两个 aside（左工作区 / 右工具）。
  it("renders the three landmark regions", () => {
    renderShell();

    // 中心对话区：唯一的 <main>，且包含 h1 欢迎语。
    const main = screen.getByRole("main");
    expect(main).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: copy.en.welcome }),
    ).toBeInTheDocument();

    // 两个 <aside>（complementary）：左=最近会话、右=调试。
    const asides = screen.getAllByRole("complementary");
    expect(asides.length).toBeGreaterThanOrEqual(2);

    // 左侧工作区面板默认展开：可见分区标题。
    expect(
      screen.getByRole("heading", { level: 2, name: copy.en.recentSessions }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: copy.en.fileSearch }),
    ).toBeInTheDocument();
  });

  // 切换左侧“收起/展开”控制，rail ↔ panel 的可见状态应随之改变。
  it("toggles the workspace panel when the collapse control is clicked", async () => {
    const user = userEvent.setup();
    renderShell();

    // 默认展开：能看到“新会话”主操作与“最近会话”标题。
    expect(
      screen.getByRole("button", { name: copy.en.newSession }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: copy.en.recentSessions }),
    ).toBeInTheDocument();

    // 点击“收起工作区”控制 → 面板隐藏，分区标题消失（切换为 rail）。
    const collapse = screen.getByRole("button", {
      name: /Collapse workspace/i,
    });
    await user.click(collapse);
    expect(
      screen.queryByRole("heading", { level: 2, name: copy.en.recentSessions }),
    ).not.toBeInTheDocument();

    // 再点击“展开工作区” → 面板恢复，标题重新出现。
    const expand = screen.getByRole("button", { name: /Expand workspace/i });
    await user.click(expand);
    expect(
      screen.getByRole("heading", { level: 2, name: copy.en.recentSessions }),
    ).toBeInTheDocument();
  });

  // axe：渲染结果零无障碍违规。
  it("has no axe violations", async () => {
    const { container } = renderShell();
    expect(await axe(container)).toHaveNoViolations();
  });

  // 打开移动端工具抽屉（Sheet）：点击右下角浮动“工具”按钮（lg:hidden，但在
  // jsdom 中仍位于 DOM 且可点击）。断言对话框出现，并对“打开态”跑 axe 零违规。
  it("opens the mobile tools drawer and has no axe violations", async () => {
    const user = userEvent.setup();
    renderShell();

    // 浮动按钮以 t.debug 命名；存在多处“Debug”按钮风险时，FAB 是触发 Sheet 的那个。
    const fabs = screen.getAllByRole("button", { name: copy.en.debug });
    // 取最后一个：FAB（SheetTrigger）渲染在 Shell 末尾，桌面右侧栏不含同名 button。
    const fab = fabs[fabs.length - 1];
    await user.click(fab);

    // Sheet 打开后应出现 dialog 角色（Base UI Dialog 渲染 role="dialog"）。
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    // 抽屉标题应可见（SheetTitle 复用 t.debug 文案）。
    expect(
      screen.getByRole("heading", { name: copy.en.debug }),
    ).toBeInTheDocument();

    // 对打开态跑 axe。注意：Base UI Dialog 会在 body 上注入隐藏的 focus-guard
    // 哨兵 <span role="button">（data-base-ui-inert，无可见名），axe 会把它误报为
    // aria-command-name 违规——这是框架内部实现，并非本应用编写的标记。因此将 axe
    // 作用域收敛到 dialog 弹层本身（我们编写的抽屉内容），既真实校验抽屉的无障碍，
    // 又不被 Base UI 的内部哨兵 span 干扰（绝不伪造通过）。
    expect(await axe(dialog)).toHaveNoViolations();
  });
});
