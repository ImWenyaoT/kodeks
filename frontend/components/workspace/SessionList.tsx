"use client";

// frontend/components/workspace/SessionList.tsx
// 最近会话列表（Task 4.4）。从 useSessions 读取会话摘要并渲染为可点击的行；
// 点击某行调用 select(id) 把该会话历史灌入全局 store。受控的「新建会话」按钮
// 不在本组件内（由 Shell 顶部主操作承载），但 newSession 同样来自同一 hook。
//
// 无障碍（Apple HIG）：
//   - 每行是真实 <button>，min-height ≥ 44px（h-12 = 48px）满足触控目标；
//   - 标题用 truncate 截断，但完整 title/id 同时进入 title 属性便于悬停查看；
//   - 当前选中行用 aria-current="true" 标注（不只靠颜色），并叠加视觉高亮；
//   - 模式图标（plan/act）aria-hidden，行的无障碍名即标题文本；
//   - 列表容器为 <ul> 并带 aria-label，紧随分区 <h2>（t.recentSessions）形成上下文。

import { ListTodo, Play } from "lucide-react";

import { useI18n } from "@/components/providers/I18nProvider";
import { useChatStore } from "@/stores/chat-store";
import { useSessions, type SessionsApi } from "@/hooks/useSessions";
import { formatSessionTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/** 最多渲染的会话行数（与后端返回顺序一致，取前 N 条）。 */
const MAX_ROWS = 20;

/**
 * 单条会话行。整行是一个 <button>，左侧为模式图标、中间为标题、右侧为时间戳。
 * @param title  展示标题（已回退为 id），用于截断展示与无障碍命名。
 * @param time   已格式化的时间文案（可能为空串）。
 * @param mode   会话模式（"plan" 走清单图标，其余走执行图标）。
 * @param active 是否为当前选中会话（控制 aria-current 与高亮）。
 * @param onSelect 点击回调（选择该会话）。
 */
function SessionRow({
  title,
  time,
  mode,
  active,
  onSelect,
}: {
  title: string;
  time: string;
  mode: string | undefined;
  active: boolean;
  onSelect: () => void;
}) {
  // plan 模式用清单图标，act / 未知用播放（执行）图标——图标仅辅助，aria-hidden。
  const Icon = mode === "plan" ? ListTodo : Play;
  return (
    <button
      type="button"
      onClick={onSelect}
      // 当前会话用 aria-current 暴露给辅助技术（不依赖颜色单独传达）。
      aria-current={active ? "true" : undefined}
      title={title}
      className={cn(
        "flex h-12 w-full items-center gap-2.5 rounded-xl px-2.5 text-left",
        "transition-colors outline-none",
        "focus-visible:ring-3 focus-visible:ring-ring/50",
        active
          ? "bg-primary/10 text-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <Icon
        className={cn(
          "size-4 shrink-0",
          active ? "text-primary" : "text-muted-foreground",
        )}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">
        {title}
      </span>
      {time && (
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {time}
        </span>
      )}
    </button>
  );
}

/**
 * 会话列表主组件。
 * 自管 loading / error / empty / 列表四种态；列表态渲染前 MAX_ROWS 条会话，
 * 并把当前 store.sessionId 对应行标为 active。
 * @param api 可选注入的 useSessions 句柄（便于测试/复用）；缺省时内部自取。
 */
export function SessionList({ api }: { api?: SessionsApi } = {}) {
  const { t } = useI18n();
  // 允许外部注入（测试场景），否则使用内部 hook 实例。
  const internal = useSessions();
  const { sessions, loading, error, select } = api ?? internal;
  // 订阅当前会话 id，用于高亮匹配行（store 变化时自动重渲染）。
  const sessionId = useChatStore((s) => s.sessionId);

  // 加载中：纯文本提示（非交互），避免空白闪烁。
  if (loading) {
    return (
      <p className="px-1 py-2 text-sm text-muted-foreground">
        {t.loadingSessions}
      </p>
    );
  }

  // 加载失败：以 role="alert" 提示，便于辅助技术即时播报。
  if (error) {
    return (
      <p role="alert" className="px-1 py-2 text-sm text-destructive">
        {t.sessionLoadError}
      </p>
    );
  }

  // 空列表：友好的空状态文案。
  if (sessions.length === 0) {
    return (
      <p className="px-1 py-2 text-sm text-muted-foreground">{t.noSessions}</p>
    );
  }

  const rows = sessions.slice(0, MAX_ROWS);

  return (
    <ul aria-label={t.recentSessions} className="flex flex-col gap-0.5">
      {rows.map((s) => (
        <li key={s.id}>
          <SessionRow
            title={s.title || s.id}
            time={formatSessionTime(s.updatedAt ?? s.createdAt)}
            mode={s.mode}
            active={s.id === sessionId}
            onSelect={() => void select(s.id)}
          />
        </li>
      ))}
    </ul>
  );
}
