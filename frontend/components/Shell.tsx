"use client";

// frontend/components/Shell.tsx
// 响应式工作区外壳（Task 3.2 / 仅外壳）：左=工作区、中=对话卡片、右=工具/调试。
// 设计目标遵循 Apple HIG —— 语义化 landmark、≥44×44 触控目标、可见键盘焦点、
// 颜色不作为唯一信号（图标恒附文字标签）。功能内容（会话列表、文件搜索、对话
// 转录、Composer 等）属于后续 Phase 4，本文件只放占位与注释槽位。
//
// 响应式策略（Tailwind 断点）：
//   - 大屏（xl ≈ ≥1280px）：左右两个侧栏默认可展开为面板；
//   - 中屏（lg–xl）：侧栏默认收起为窄轨道（rail），可手动展开；
//   - 小屏（<lg）：隐藏两个侧栏，改由右下浮动按钮打开 Sheet 抽屉（移动端）。
// Sheet 基于 Base UI，自带焦点陷阱 / Esc 关闭 / 焦点回归，无需手写。

import { useState, type ReactNode } from "react";
import {
  Activity,
  History,
  MessageSquare,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import { useI18n } from "@/components/providers/I18nProvider";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Transcript } from "@/components/chat/Transcript";
import { Composer } from "@/components/chat/Composer";
import { SessionList } from "@/components/workspace/SessionList";
import { FilePicker } from "@/components/workspace/FilePicker";
import { useSessions } from "@/hooks/useSessions";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

/**
 * 轨道（rail）上的图标按钮。
 * HIG：真实 <button>、≥44×44 触控目标（size-11 = 44px）、aria-label、可见焦点。
 * 始终带 sr-only 文字，避免“仅靠图标/颜色传达含义”。
 * @param icon  lucide 图标组件。
 * @param label 无障碍标签（同时作为可见的 sr-only 文本）。
 * @param onClick 点击回调。
 */
function RailButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="size-11 rounded-xl text-muted-foreground hover:text-foreground"
    >
      <Icon className="size-5" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </Button>
  );
}

/**
 * 面板内的“标题 + 内容”分区。
 * HIG：使用 <section> + 标题（<h2>），让屏幕阅读器可按分区导航；
 * 内容此刻为占位，真正功能在 Phase 4 接入。
 * @param title    分区标题（取自 i18n 文案）。
 * @param icon     分区图标（仅装饰，aria-hidden）。
 * @param children 占位内容或 Phase 4 注释槽位。
 */
function PanelSection({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <section className="px-3 py-3">
      <h2 className="mb-2 flex items-center gap-2 px-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        <Icon className="size-3.5" aria-hidden="true" />
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * 占位用的虚线空状态块。功能内容到位前给用户清晰的“此处将有内容”提示。
 * @param children 占位说明文字。
 */
function Placeholder({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border/70 bg-muted/30 px-3 py-4 text-sm text-muted-foreground">
      {children}
    </div>
  );
}

/**
 * 左侧工作区面板的内容（展开态）。
 * 含主操作“新会话”以及“最近会话（SessionList）/ 文件搜索”分区。
 * 在此持有单一 useSessions 实例，使「新会话」按钮与列表共享同一份数据与动作：
 * 新建会话后列表自动刷新，选择列表项后亦在同一上下文中生效。
 */
function WorkspacePanelBody() {
  const { t } = useI18n();
  // 单一来源：newSession 给顶部主操作，整个 api 透传给 SessionList 复用。
  const sessions = useSessions();
  return (
    <>
      <div className="px-3 pt-3">
        {/* 主操作：新会话。HIG：高度 44px（h-11）保证触控目标。可见文字已命名按钮，无需 aria-label。 */}
        <Button
          type="button"
          onClick={sessions.newSession}
          className="h-11 w-full justify-start gap-2 rounded-xl"
        >
          <Plus className="size-4" aria-hidden="true" />
          {t.newSession}
        </Button>
      </div>

      <PanelSection title={t.recentSessions} icon={History}>
        {/* Phase 4: SessionList —— 最近会话列表（共享上方 useSessions 实例）。 */}
        <SessionList api={sessions} />
      </PanelSection>

      <PanelSection title={t.fileSearch} icon={Search}>
        {/* Phase 4: FileSearch —— workspace 文件搜索 + 选择（Task 4.5） */}
        <FilePicker />
      </PanelSection>
    </>
  );
}

/**
 * 右侧工具/调试面板的内容（展开态，桌面与移动 Sheet 复用）。
 * 五个占位分区：MoonBridge / 外观 / 运行设置 / 运行事件 / 审批。
 * @param headingLevel 标题层级提示——此处统一用 <h2>，故无需参数化，分区自带。
 */
function ToolsPanelBody() {
  const { t } = useI18n();
  return (
    <>
      <PanelSection title={t.bridge} icon={Wrench}>
        {/* Phase 4: MoonBridge 状态与预检 */}
        <Placeholder>{t.bridgeMessage}</Placeholder>
      </PanelSection>

      <PanelSection title={t.appearance} icon={Palette}>
        {/* Phase 4: Appearance —— 主题/语言切换 */}
        <Placeholder>{t.system}</Placeholder>
      </PanelSection>

      <PanelSection title={t.runtime} icon={SlidersHorizontal}>
        {/* Phase 4: Runtime —— provider / model / reasoning 设置 */}
        <Placeholder>{t.notConfigured}</Placeholder>
      </PanelSection>

      <PanelSection title={t.runtimeEvents} icon={Activity}>
        {/* Phase 4: Runtime events —— 运行事件流 */}
        <Placeholder>{t.activity}</Placeholder>
      </PanelSection>

      <PanelSection title={t.approvals} icon={ShieldCheck}>
        {/* Phase 4: Approvals —— 工具调用审批队列 */}
        <Placeholder>{t.approvals}</Placeholder>
      </PanelSection>
    </>
  );
}

/**
 * 工作区外壳主组件。
 * 维护左右两侧的展开/收起状态，并按断点呈现 rail ↔ panel；小屏由 Sheet 抽屉
 * 承载右侧工具区。
 */
export function Shell() {
  const { t } = useI18n();
  // 左右侧栏的展开状态。初值 true：大屏默认展开；中屏通过 CSS（见下）收窄为 rail。
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  // 移动端工具抽屉的开关（受控，便于关闭后焦点回归由 Sheet 处理）。
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false);

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden bg-background text-foreground">
      {/* ───────── 左：工作区（aside）。小屏(<lg)隐藏，由会话本身的中心区承载。 ───────── */}
      <aside
        aria-label={t.recentSessions}
        className={cn(
          "hidden h-full shrink-0 flex-col border-r border-border bg-sidebar transition-[width] duration-200 ease-out lg:flex",
          leftOpen ? "w-72" : "w-16",
        )}
      >
        {/* 顶部：展开/收起控制 + 收起态的图标轨道。 */}
        <div
          className={cn(
            "flex items-center gap-1 border-b border-border px-2 py-2",
            leftOpen ? "justify-between" : "justify-center",
          )}
        >
          {leftOpen && (
            <span className="px-2 text-sm font-semibold">Kodeks</span>
          )}
          <Button
            type="button"
            variant="ghost"
            onClick={() => setLeftOpen((v) => !v)}
            aria-label={leftOpen ? t.collapseWorkspace : t.expandWorkspace}
            aria-expanded={leftOpen}
            title={leftOpen ? t.collapseWorkspace : t.expandWorkspace}
            className="size-11 rounded-xl text-muted-foreground hover:text-foreground"
          >
            {leftOpen ? (
              <PanelLeftClose className="size-5" aria-hidden="true" />
            ) : (
              <PanelLeftOpen className="size-5" aria-hidden="true" />
            )}
            <span className="sr-only">
              {leftOpen ? t.collapseWorkspace : t.expandWorkspace}
            </span>
          </Button>
        </div>

        {leftOpen ? (
          // 展开态：完整面板，可滚动。
          <div className="flex-1 overflow-y-auto">
            <WorkspacePanelBody />
          </div>
        ) : (
          // 收起态：窄轨道，仅图标按钮（每个都带 sr-only 文字与 aria-label）。
          <nav
            aria-label={t.recentSessions}
            className="flex flex-1 flex-col items-center gap-1 py-2"
          >
            <RailButton
              icon={Plus}
              label={t.newSession}
              onClick={() => setLeftOpen(true)}
            />
            <RailButton
              icon={MessageSquare}
              label={t.recentSessions}
              onClick={() => setLeftOpen(true)}
            />
            <RailButton
              icon={Search}
              label={t.fileSearch}
              onClick={() => setLeftOpen(true)}
            />
          </nav>
        )}
      </aside>

      {/* ───────── 中：对话卡片（main）。占据剩余宽度，内容居中约束在 max-w-3xl。 ───────── */}
      <main className="flex min-w-0 flex-1 flex-col">
        {/* 顶栏：在小屏(<lg)给出对称留白；主区域始终保留语义标题 h1。 */}
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4">
          {/* 欢迎行（h1 作为本页主标题，满足单一 main 标题）。 */}
          <header className="safe-t pt-6 pb-2">
            <h1 className="text-lg font-semibold tracking-tight text-balance">
              {t.welcome}
            </h1>
          </header>

          {/* 转录区（Task 4.2）：Transcript 自带 role="log" + aria-live 等
              live region 属性与 aria-label，故此处不再额外包裹 <section>，
              避免重复的无障碍标签。 */}
          <Transcript />

          {/* 底部 Composer（Task 4.3）。safe-b：刘海/手势条安全区内边距——
              本壳层已统一处理底部安全区，Composer 内部不再重复施加。 */}
          <div className="safe-b sticky bottom-0 bg-gradient-to-t from-background via-background to-transparent pt-2 pb-4">
            <Composer />
          </div>
        </div>
      </main>

      {/* ───────── 右：工具/调试（aside）。小屏(<lg)隐藏，改由 Sheet 抽屉承载。 ───────── */}
      <aside
        aria-label={t.debug}
        className={cn(
          "hidden h-full shrink-0 flex-col border-l border-border bg-sidebar transition-[width] duration-200 ease-out lg:flex",
          rightOpen ? "w-80" : "w-16",
        )}
      >
        {/* 顶部：展开/收起控制 + 收起态图标轨道。 */}
        <div
          className={cn(
            "flex items-center gap-1 border-b border-border px-2 py-2",
            rightOpen ? "justify-between" : "justify-center",
          )}
        >
          <Button
            type="button"
            variant="ghost"
            onClick={() => setRightOpen((v) => !v)}
            aria-label={rightOpen ? t.collapseTools : t.expandTools}
            aria-expanded={rightOpen}
            title={rightOpen ? t.collapseTools : t.expandTools}
            className="size-11 rounded-xl text-muted-foreground hover:text-foreground"
          >
            {rightOpen ? (
              <PanelRightClose className="size-5" aria-hidden="true" />
            ) : (
              <PanelRightOpen className="size-5" aria-hidden="true" />
            )}
            <span className="sr-only">
              {rightOpen ? t.collapseTools : t.expandTools}
            </span>
          </Button>
          {rightOpen && (
            <span className="px-2 text-sm font-semibold">{t.debug}</span>
          )}
        </div>

        {rightOpen ? (
          <div className="flex-1 overflow-y-auto">
            <ToolsPanelBody />
          </div>
        ) : (
          <nav
            aria-label={t.debug}
            className="flex flex-1 flex-col items-center gap-1 py-2"
          >
            <RailButton
              icon={Wrench}
              label={t.bridge}
              onClick={() => setRightOpen(true)}
            />
            <RailButton
              icon={Palette}
              label={t.appearance}
              onClick={() => setRightOpen(true)}
            />
            <RailButton
              icon={Settings2}
              label={t.runtime}
              onClick={() => setRightOpen(true)}
            />
            <RailButton
              icon={Activity}
              label={t.runtimeEvents}
              onClick={() => setRightOpen(true)}
            />
            <RailButton
              icon={ShieldCheck}
              label={t.approvals}
              onClick={() => setRightOpen(true)}
            />
          </nav>
        )}
      </aside>

      {/* ───────── 小屏：浮动“工具”按钮 + Sheet 抽屉（仅 <lg 显示）。 ───────── */}
      <Sheet open={mobileToolsOpen} onOpenChange={setMobileToolsOpen}>
        <SheetTrigger
          render={
            <Button
              type="button"
              aria-label={t.debug}
              title={t.debug}
              className="safe-b safe-x fixed right-4 bottom-4 z-40 size-14 rounded-full shadow-lg lg:hidden"
            />
          }
        >
          <Wrench className="size-5" aria-hidden="true" />
          <span className="sr-only">{t.debug}</span>
        </SheetTrigger>
        {/* Sheet（Base UI）自带：焦点陷阱、Esc 关闭、关闭后焦点回归触发器。 */}
        <SheetContent side="right" className="w-[85vw] sm:max-w-sm">
          <SheetHeader>
            <SheetTitle>{t.debug}</SheetTitle>
            <SheetDescription>{t.bridgeMessage}</SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto pb-4">
            <ToolsPanelBody />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
