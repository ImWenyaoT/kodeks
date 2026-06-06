// frontend/components/tools/AppearanceControls.test.tsx
// 外观控件（Task 4.6）测试：
//   1. 主题切换 → next-themes 应用（断言 document.documentElement 的 class 切换为 dark）；
//   2. 语言切换 → 切到中文后界面文案随之变化（用 i18n 的可见文案断言 preference 生效）；
//   3. 两组 ToggleGroup 均有可访问名称（role=group + accessible name）；
//   4. axe(container) 零违规。
// matchMedia 桩件供 next-themes；本组件不触网，无需 mock api。

import { describe, it, expect, beforeAll, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";

import { AppearanceControls } from "./AppearanceControls";
import { I18nProvider } from "@/components/providers/I18nProvider";
import { ThemeProvider } from "@/components/providers/ThemeProvider";
import { copy } from "@/lib/i18n";

// vitest-axe 的类型增强（运行期匹配器在 test/setup.ts 注册）。
declare module "@vitest/expect" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Matchers<T = any> {
    toHaveNoViolations(): T;
  }
}

/** 在应用 Provider 中渲染 AppearanceControls（含 ThemeProvider + I18nProvider）。 */
function renderControls() {
  return render(
    <ThemeProvider>
      <I18nProvider>
        <AppearanceControls />
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

describe("AppearanceControls", () => {
  // 主题切换：点 Dark 后 next-themes 给 <html> 加上 dark class。
  it("applies the selected theme via next-themes", async () => {
    const user = userEvent.setup();
    const t = copy.en;
    renderControls();

    await user.click(screen.getByRole("button", { name: t.dark }));
    await waitFor(() =>
      expect(document.documentElement.classList.contains("dark")).toBe(true),
    );

    // 切回 Light：dark class 被移除。
    await user.click(screen.getByRole("button", { name: t.light }));
    await waitFor(() =>
      expect(document.documentElement.classList.contains("dark")).toBe(false),
    );
  });

  // 语言切换：切到中文后界面文案随之变化（断言 preference 经 i18n 生效）。
  it("switches the language preference and updates copy", async () => {
    const user = userEvent.setup();
    renderControls();

    // 默认（system→en 解析）下，语言组英文标签 "中文" 即 zh 选项，点击切到中文。
    await user.click(screen.getByRole("button", { name: copy.en.zh }));

    // 切到中文后，顶部小标题应显示中文「外观」（之前为英文 "Appearance"）。
    await waitFor(() =>
      expect(screen.getByText(copy.zh.appearance)).toBeInTheDocument(),
    );
    expect(screen.queryByText(copy.en.appearance)).not.toBeInTheDocument();
  });

  // 两组 ToggleGroup 均有可访问名称（role=toolbar，见组件内 aria 修复说明）。
  it("names each toggle group accessibly", () => {
    renderControls();
    // 两组（主题、语言）都是 role=toolbar，且各自带 accessible name（非空）。
    const groups = screen.getAllByRole("toolbar");
    expect(groups.length).toBeGreaterThanOrEqual(2);
    for (const g of groups) {
      expect(g).toHaveAccessibleName();
    }
  });

  // axe：外观控件区零无障碍违规。
  it("has no axe violations", async () => {
    const { container } = renderControls();
    expect(await axe(container)).toHaveNoViolations();
  });
});
