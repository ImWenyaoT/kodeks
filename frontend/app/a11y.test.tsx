// frontend/app/a11y.test.tsx
// 全页无障碍验收（Task 6.1）：在 Provider 中渲染完整首页（<Shell/> 已槽入全部
// 功能组件：Transcript / Composer / SessionList / FilePicker / RuntimeSettings /
// AppearanceControls / BridgeStatus / RuntimeEvents / ApprovalList），让每个组件
// 都真正挂载并完成首屏异步副作用后，对整页跑 axe，断言零违规。
//
// 与单组件测试不同：本测试覆盖「组装后」的整体页面，确保 landmark 不冲突、
// live region/aria 标注在共存时仍然成立——这是 HIG 契约层的端到端验收。
//
// 网络隔离：mock 整个 @/lib/api。因 vi.mock 会替换整个模块，故除任务要求的
// getSessions/getWorkspaceFiles/getModels/bridgePreflight 四个外，还需补齐挂载树
// 中其它会被引用到的导出（getSession/decideApproval/openChatStream），否则它们会
// 变成 undefined，在交互或挂载路径上抛错。matchMedia 打桩供 next-themes；
// 每个用例前 reset store 保证隔离。

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { axe } from "vitest-axe";

import Home from "./page";
import { I18nProvider } from "@/components/providers/I18nProvider";
import { ThemeProvider } from "@/components/providers/ThemeProvider";
import { useChatStore } from "@/stores/chat-store";
import { copy } from "@/lib/i18n";

// vitest-axe 的类型增强：为新接口（@vitest/expect 的 Matchers<T>）补一条声明合并，
// 让 toHaveNoViolations 在断言上类型可见（运行期匹配器已在 test/setup.ts 注册）。
declare module "@vitest/expect" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Matchers<T = any> {
    toHaveNoViolations(): T;
  }
}

// 整模块 mock：替换 @/lib/api 的全部导出。因 vi.mock 工厂会被提升到文件顶部，
// 不能引用任何顶层变量，故下列返回值（模型目录 / 会话 / 文件 / 预检）只能内联：
//   - getModels：单 provider 单模型、configured=true、primary 指向该模型，让
//     RuntimeSettings/BridgeStatus 等依赖目录的组件进入「已加载」可见态；
//   - getSessions：1 条会话，使 SessionList 渲染出真正的列表行（<ul>/<li>/<button>），
//     而非空状态——这样整页 axe 才能覆盖到「会话行」这类带 aria-current/可命名按钮的 DOM；
//   - getWorkspaceFiles：几个文件，供 FilePicker 懒加载（即便本测试未展开 picker，
//     mock 也保持完整，使「全部数据 API 均被 mock」成立）；
//   - bridgePreflight：ready + resolvedProvider，让 BridgeStatus 落定到「就绪」态；
//   - getSession/decideApproval/openChatStream：惰性桩，仅保证模块形状完整。
vi.mock("@/lib/api", () => ({
  getSessions: vi.fn().mockResolvedValue([
    {
      id: "s1",
      title: "Test session",
      mode: "act",
      updatedAt: "2026-06-06T12:00:00.000Z",
    },
  ]),
  getSession: vi.fn().mockResolvedValue({ messages: [] }),
  getWorkspaceFiles: vi
    .fn()
    .mockResolvedValue(["src/app.py", "README.md", "frontend/app/page.tsx"]),
  getModels: vi.fn().mockResolvedValue({
    primary: "deepseek/chat",
    models: [
      {
        ref: "deepseek/chat",
        providerId: "deepseek",
        providerName: "DeepSeek",
        modelName: "DeepSeek Chat",
        configured: true,
      },
    ],
  }),
  bridgePreflight: vi
    .fn()
    .mockResolvedValue({ status: "ready", resolvedProvider: "deepseek" }),
  decideApproval: vi.fn().mockResolvedValue({}),
  openChatStream: vi.fn(),
}));

// 默认 lang 解析为 en（jsdom 下 navigator.language 非 zh）。
const t = copy.en;

/** 在应用 Provider 中渲染完整首页（<Shell/>）。 */
function renderPage() {
  return render(
    <ThemeProvider>
      <I18nProvider>
        <Home />
      </I18nProvider>
    </ThemeProvider>,
  );
}

/**
 * 等待整页的首屏异步副作用全部落定，避免 axe 跑在「加载中」的中间态、
 * 也避免 act() 告警（所有 setState 都在 findBy/waitFor 内被 flush）。
 * 覆盖三条独立的数据加载链：模型目录 → store 播种、会话列表、bridge 预检。
 */
async function settleEffects() {
  // 1) useModels 加载目录后把 store.model 播种为 primary。
  await waitFor(() =>
    expect(useChatStore.getState().model).toBe("deepseek/chat"),
  );
  // 2) model 下拉 trigger（combobox）显示模型名。作用域到 trigger，避开下拉项里
  //    同名的 ItemText（Base UI 会挂载选中项文本，全局 findByText 会命中两处）。
  const modelTrigger = await screen.findByRole("combobox", { name: t.model });
  expect(within(modelTrigger).getByText("DeepSeek Chat")).toBeInTheDocument();
  // 3) 会话列表已由 mock 填充出一行（确认 SessionList 进入「列表态」而非空态）。
  await screen.findByText("Test session");
  // 4) bridge 预检完成，状态文字落定为「就绪」。
  await screen.findByText(t.ready);
}

// jsdom 不实现 matchMedia；next-themes 与潜在媒体查询读取都依赖它。
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

// 每个用例前 reset store；并把 settings 复位为「未选定」，确保 useModels 的播种
// 逻辑（仅在 store.model 为空时播种）每次都能触发，避免跨用例残留影响。
beforeEach(() => {
  useChatStore.getState().reset();
  useChatStore.getState().setSettings({
    model: "",
    providerId: "",
    mode: "act",
    reasoning: "medium",
  });
});

describe("Full-page accessibility (assembled Shell)", () => {
  // 整页 axe：等三条数据链落定后，对整页跑 axe，断言零违规。
  it("has no axe violations once async effects settle", async () => {
    const { container } = renderPage();
    await settleEffects();

    // 以 render() 返回的 container（受测应用的真实 DOM 根）为 axe 作用域，而非
    // document.body。原因：Base UI 的 Select 弹层 / Sheet 抽屉等都经 Portal 渲染
    // 到 body 之外，框架也可能在 body 注入内部 focus-guard 哨兵节点；以 container
    // 为根可排除这些「框架内部产物」造成的误报，同时完整覆盖我们编写的、当前可见
    // 的整页 UI（本测试未打开任何弹层）。经核验整页未发现需要抑制的真实违规。
    expect(await axe(container)).toHaveNoViolations();
  });

  // landmark 完整性：整页恰好一个 <main>，且同类 landmark 命名无冲突。
  it("exposes exactly one main landmark with non-conflicting landmark names", async () => {
    renderPage();
    await settleEffects();

    // 恰好一个 <main>（getAllByRole 命中数量 = 1）。
    const mains = screen.getAllByRole("main");
    expect(mains).toHaveLength(1);

    // 两个 <aside>（complementary）：左=最近会话、右=调试，命名互不相同。
    const asides = screen.getAllByRole("complementary");
    const asideNames = asides.map((el) => el.getAttribute("aria-label"));
    expect(asideNames).toContain(t.recentSessions);
    expect(asideNames).toContain(t.debug);
    // 无重复/冲突的 landmark 名：同类型 landmark 的 aria-label 应彼此唯一。
    expect(new Set(asideNames).size).toBe(asideNames.length);
  });
});
