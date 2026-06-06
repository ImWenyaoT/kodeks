"use client";

// frontend/components/tools/BridgeStatus.tsx
// MoonBridge 预检状态卡片（Task 4.7）：把 useBridgePreflight 的状态机渲染成一张卡片。
// 数据来源：useBridgePreflight（监听 store.model，挂载/切换时自动预检）。
//
// HIG / 无障碍要点：
//   - 状态不仅靠颜色：圆点用 AA 安全的 --status-* 令牌着色，但状态含义始终由
//     「本地化的状态标题文字」承载（修复审计「仅靠颜色/低对比圆点传达状态」的发现）。
//   - 状态区为 aria-live="polite"：标题 + 说明放入礼貌更新的容器，屏幕阅读器能依次
//     听到「正在预检… → Bridge 已就绪」，而不打断用户当前操作。
//   - 刷新按钮是真实 <button>，带 aria-label、≥44×44 触控目标（size-11）、可见焦点。
//   - 明细行 label/value 成对；value 溢出 truncate，并以 title 提供完整文本。

import { Plug, RefreshCw } from "lucide-react";

import { useI18n } from "@/components/providers/I18nProvider";
import { useBridgePreflight, type BridgeStatus as Status } from "@/hooks/useBridgePreflight";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * 把状态映射到「圆点颜色令牌」与「卡片边框令牌」的工具类名。
 * ready→ready 绿、checking/not_required→warn 琥珀（中性提示）、unavailable→danger 红。
 * 颜色仅作辅助；含义由 statusTitle 的文字承载。
 */
const STATUS_DOT: Record<Status, string> = {
  ready: "bg-status-ready",
  checking: "bg-status-warn",
  not_required: "bg-status-ready",
  unavailable: "bg-status-danger",
};

/** 状态 → 卡片左边框着色（与圆点同色系，强化但不单独依赖颜色）。 */
const STATUS_BORDER: Record<Status, string> = {
  ready: "border-l-status-ready",
  checking: "border-l-status-warn",
  not_required: "border-l-status-ready",
  unavailable: "border-l-status-danger",
};

/**
 * 单条只读明细行：左 label、右 value。
 * value 溢出时 truncate，并把完整文本放进 title（鼠标悬停可读全量）。
 * @param label 行标签（本地化）。
 * @param value 行取值（已做空值兜底为「未配置」）。
 */
function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-xs font-medium" title={value}>
        {value}
      </dd>
    </div>
  );
}

/**
 * MoonBridge 预检状态卡片。
 * 卡片头部：状态圆点 + 本地化状态标题 + 刷新按钮；说明行展示 reason 或默认文案；
 * 明细区以 dl 列出 provider / bridge / upstream / model 四项只读信息。
 */
export function BridgeStatus() {
  const { t } = useI18n();
  const { status, detail, refresh } = useBridgePreflight();

  // 状态标题：parity 要求 —— ready/not_required/checking 各有专属文案，其余落到 unavailable。
  const statusTitle =
    status === "ready"
      ? t.ready
      : status === "not_required"
        ? t.notRequired
        : status === "checking"
          ? t.checking
          : t.unavailable;

  // 说明行：优先服务端 reason，否则默认「正在确认…」文案。
  const message = detail?.reason || t.bridgeMessage;

  // 明细取值：按 parity 规则做多级兜底。
  const provider = detail?.resolvedProvider || detail?.provider || "auto";
  const bridge = detail?.bridgeBaseURL || t.notConfigured;
  const upstream = detail?.upstreamBaseURL || t.notConfigured;
  const modelValue = detail?.upstreamModel || detail?.bridgeModel || t.notConfigured;

  return (
    <div
      className={cn(
        "rounded-xl border border-l-4 border-border bg-card p-3",
        STATUS_BORDER[status],
      )}
    >
      {/* 头部：状态圆点 + 标题（左），刷新按钮（右）。 */}
      <div className="flex items-start justify-between gap-2">
        {/* 状态区：aria-live 礼貌更新，让 AT 依次播报状态标题与说明。 */}
        <div aria-live="polite" className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {/* 圆点仅辅助；用 AA 安全的 --status-* 令牌。aria-hidden 因含义已由文字传达。 */}
            <span
              aria-hidden="true"
              className={cn("size-2.5 shrink-0 rounded-full", STATUS_DOT[status])}
            />
            <span className="flex items-center gap-1.5 text-sm font-semibold">
              <Plug className="size-3.5 text-muted-foreground" aria-hidden="true" />
              {statusTitle}
            </span>
          </div>
          {/* 说明行：reason 或默认文案。 */}
          <p className="mt-1 text-xs text-muted-foreground">{message}</p>
        </div>

        {/* 刷新按钮：真实 <button>，44×44 触控目标（size-11）、aria-label、可见焦点。 */}
        <Button
          type="button"
          variant="ghost"
          onClick={refresh}
          aria-label={t.refresh}
          title={t.refresh}
          className="size-11 shrink-0 rounded-xl text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          <span className="sr-only">{t.refresh}</span>
        </Button>
      </div>

      {/* 明细区：四项只读 label/value。 */}
      <dl className="mt-3 border-t border-border/60 pt-2">
        <DetailRow label={t.provider} value={provider} />
        <DetailRow label={t.bridge} value={bridge} />
        <DetailRow label="Upstream" value={upstream} />
        <DetailRow label={t.model} value={modelValue} />
      </dl>
    </div>
  );
}
