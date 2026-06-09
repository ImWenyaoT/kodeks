// frontend/components/tools/RuntimeSettings.test.tsx
// 运行设置控件（Task 4.6）测试：
//   1. 加载后 provider 与 model 下拉从 mock 目录填充（trigger 显示选中项 label）；
//   2. 通过 model 下拉选择另一个模型 → useChatStore.getState().model 更新；
//   3. mode 切换（act/plan）→ getState().mode 更新；
//   4. axe(container) 零违规（Base UI Select 的 Popup 通过 Portal 渲染在容器外，
//      关闭态下不在 DOM 中，故 axe(container) 已能覆盖可见的 trigger/标签/ToggleGroup）。
// 通过 mock @/lib/api 的 getModels 隔离网络；matchMedia 桩件供 next-themes；
// 每个用例前 reset store。

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";

import { RuntimeSettings } from "./RuntimeSettings";
import { I18nProvider } from "@/components/providers/I18nProvider";
import { ThemeProvider } from "@/components/providers/ThemeProvider";
import { useChatStore } from "@/stores/chat-store";
import { copy } from "@/lib/i18n";
import type { ModelCatalog } from "@/lib/api";
import * as api from "@/lib/api";

// vitest-axe 的类型增强（运行期匹配器在 test/setup.ts 注册）。
declare module "@vitest/expect" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Matchers<T = any> {
    toHaveNoViolations(): T;
  }
}

// 仅 mock 本测试关心的 getModels。
vi.mock("@/lib/api", () => ({
  getModels: vi.fn(),
}));

const getModelsMock = vi.mocked(api.getModels);

// 默认 lang 为 en；断言统一取 copy.en。
const t = copy.en;

// 测试目录：两个 provider，openai 含两个模型、anthropic 含一个；primary 指向第二个 openai 模型。
const CATALOG: ModelCatalog = {
  primary: "openai/gpt-5",
  models: [
    {
      ref: "openai/gpt-4o",
      providerId: "openai",
      providerName: "OpenAI",
      modelName: "GPT-4o",
      configured: true,
    },
    {
      ref: "openai/gpt-5",
      providerId: "openai",
      providerName: "OpenAI",
      modelName: "GPT-5",
      configured: true,
    },
    {
      ref: "anthropic/claude",
      providerId: "anthropic",
      providerName: "Anthropic",
      modelName: "Claude",
      configured: true,
    },
  ],
};

/** 在应用 Provider 中渲染 RuntimeSettings（依赖 useI18n + next-themes）。 */
function renderSettings() {
  return render(
    <ThemeProvider>
      <I18nProvider>
        <RuntimeSettings />
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

// 每个用例前 reset store 与 mock，复位默认目录返回值。
beforeEach(() => {
  useChatStore.getState().reset();
  // reset 仅清运行态、保留 settings；显式把 settings 复位为未选定，确保播种逻辑可触发。
  useChatStore.getState().setSettings({
    model: "",
    providerId: "",
    mode: "act",
    reasoning: "medium",
  });
  getModelsMock.mockReset();
  getModelsMock.mockResolvedValue(structuredClone(CATALOG));
});

describe("RuntimeSettings", () => {
  // 加载后：provider/model 下拉按 primary 播种，trigger 显示对应 label。
  it("populates provider and model selects from the catalog after load", async () => {
    renderSettings();

    // 播种到 primary（openai/gpt-5）：store 同步、两个 trigger 显示对应 label。
    await waitFor(() =>
      expect(useChatStore.getState().model).toBe("openai/gpt-5"),
    );
    expect(useChatStore.getState().providerId).toBe("openai");

    // provider trigger 以 aria-label 命名；显示 provider 名。
    const providerTrigger = screen.getByRole("combobox", { name: t.provider });
    expect(within(providerTrigger).getByText("OpenAI")).toBeInTheDocument();

    // model trigger 显示播种的模型名。
    const modelTrigger = screen.getByRole("combobox", { name: t.model });
    expect(within(modelTrigger).getByText("GPT-5")).toBeInTheDocument();
  });

  // 通过 model 下拉选择另一个模型 → store.model 更新。
  it("updates the store model when a model is selected", async () => {
    const user = userEvent.setup();
    renderSettings();

    await waitFor(() =>
      expect(useChatStore.getState().model).toBe("openai/gpt-5"),
    );

    // 打开 model 下拉并选择 GPT-4o。
    await user.click(screen.getByRole("combobox", { name: t.model }));
    const option = await screen.findByRole("option", { name: "GPT-4o" });
    await user.click(option);

    await waitFor(() =>
      expect(useChatStore.getState().model).toBe("openai/gpt-4o"),
    );
  });

  // mode 切换（act → plan）→ store.mode 更新。
  it("updates the store mode via the mode toggle", async () => {
    const user = userEvent.setup();
    renderSettings();
    await waitFor(() => expect(getModelsMock).toHaveBeenCalled());

    // 初始 act；点 Plan 后切换为 plan。
    expect(useChatStore.getState().mode).toBe("act");
    await user.click(screen.getByRole("button", { name: t.plan }));
    await waitFor(() => expect(useChatStore.getState().mode).toBe("plan"));

    // 再点 Act 切回。
    await user.click(screen.getByRole("button", { name: t.act }));
    await waitFor(() => expect(useChatStore.getState().mode).toBe("act"));
  });

  // axe：控件区（trigger/标签/ToggleGroup 可见态）零无障碍违规。
  it("has no axe violations", async () => {
    const { container } = renderSettings();
    await waitFor(() =>
      expect(useChatStore.getState().model).toBe("openai/gpt-5"),
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
