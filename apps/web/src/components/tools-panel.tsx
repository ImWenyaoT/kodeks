"use client";

import React from "react";

import {
  defaultToolDefinitions,
  type JsonSchemaProperty,
  type ToolDefinition,
} from "@kodeks/tools/definitions";

import { MaterialIcon } from "@/components/material-icon";
import type {
  ConfiguredModelOption,
  MoonBridgePreflightView,
} from "@/lib/kodeks-api";
import type {
  UiCopy,
  UiLanguagePreference,
  UiThemePreference,
} from "@/lib/ui-copy";

type ToolsPanelProps = {
  collapsed?: boolean;
  mode: "act" | "plan";
  selectedModel: string;
  modelOptions: ConfiguredModelOption[];
  bridgePreflight: MoonBridgePreflightView;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  sessionId: string;
  activityCount: number;
  copy: UiCopy["tools"];
  language: UiLanguagePreference;
  theme: UiThemePreference;
  onLanguageChange: (language: UiLanguagePreference) => void;
  onModeChange: (mode: "act" | "plan") => void;
  onModelChange: (model: string) => void;
  onBridgePreflightRefresh?: () => void;
  onReasoningEffortChange?: (
    effort: "low" | "medium" | "high" | "xhigh",
  ) => void;
  onCollapseToggle?: () => void;
  onThemeChange: (theme: UiThemePreference) => void;
};

type SegmentOption<TValue extends string> = {
  value: TValue;
  label: string;
};

const railToolEntries = [
  { icon: "smart_toy", tone: "bg-blue-100 text-blue-700" },
  { icon: "terminal", tone: "bg-amber-100 text-amber-700" },
  { icon: "code", tone: "bg-emerald-100 text-emerald-700" },
  { icon: "memory", tone: "bg-fuchsia-100 text-fuchsia-700" },
  { icon: "account_tree", tone: "bg-indigo-100 text-indigo-700" },
  { icon: "shield", tone: "bg-rose-100 text-rose-700" },
];

const bridgeStatusTone: Record<
  MoonBridgePreflightView["status"],
  { dot: string; text: string; ring: string }
> = {
  checking: {
    dot: "bg-amber-400",
    text: "text-amber-700 dark:text-amber-300",
    ring: "ring-amber-200 dark:ring-amber-500/30",
  },
  ready: {
    dot: "bg-emerald-500",
    text: "text-emerald-700 dark:text-emerald-300",
    ring: "ring-emerald-200 dark:ring-emerald-500/30",
  },
  unavailable: {
    dot: "bg-rose-500",
    text: "text-rose-700 dark:text-rose-300",
    ring: "ring-rose-200 dark:ring-rose-500/30",
  },
  not_required: {
    dot: "bg-slate-400",
    text: "text-slate-600 dark:text-slate-300",
    ring: "ring-slate-200 dark:ring-[#343a40]",
  },
};

// Converts JSON schema primitive names into the compact labels shown in the tool list.
function formatSchemaType(property: JsonSchemaProperty | undefined): string {
  if (property === undefined) {
    return "unknown";
  }
  if (Array.isArray(property.type)) {
    return property.type.join(" | ");
  }
  if (property.type !== undefined) {
    return property.type;
  }
  if (property.enum !== undefined) {
    return "string";
  }
  if (property.properties !== undefined) {
    return "object";
  }
  if (property.items !== undefined) {
    return "array";
  }
  return "unknown";
}

// Renders a provider-facing tool definition as a TypeScript-like function signature.
export function formatToolSignature(tool: ToolDefinition): string {
  const required = new Set(tool.parameters.required ?? []);
  const parameters = Object.entries(tool.parameters.properties).map(
    ([name, property]) => {
      const optionalMarker = required.has(name) ? "" : "?";
      return `${name}${optionalMarker}: ${formatSchemaType(property)}`;
    },
  );
  return `${tool.name}(${parameters.join(", ")})`;
}

// 渲染一组分段按钮，用 key 固定每个选项，避免切换语言时旧选中态残留。
function SegmentedControl<TValue extends string>({
  value,
  options,
  onChange,
}: {
  value: TValue;
  options: Array<SegmentOption<TValue>>;
  onChange: (value: TValue) => void;
}) {
  return (
    <div
      className="kodeks-control-text grid rounded-full border border-slate-200 bg-slate-100 p-1 text-slate-600 dark:border-[#343a40] dark:bg-[#1b1d21] dark:text-slate-300"
      style={{
        gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))`,
      }}
    >
      {options.map((option) => {
        const isSelected = option.value === value;
        return (
          <button
            aria-pressed={isSelected}
            className={`rounded-full px-2 py-1.5 transition ${
              isSelected
                ? "bg-white text-slate-950 shadow-sm dark:bg-[#30353b] dark:text-white"
                : "hover:text-slate-950 dark:hover:text-white"
            }`}
            key={option.value}
            onClick={() => onChange(option.value)}
            type="button"
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

// 渲染 NotebookLM-style 的右栏功能区块。
function DebugSection({
  title,
  icon,
  children,
}: {
  title: string;
  icon: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-[14px] bg-slate-50 p-3 dark:bg-[#24282d]">
      <div className="flex items-center gap-2">
        <span className="inline-flex size-7 items-center justify-center rounded-[10px] bg-white text-slate-600 shadow-sm ring-1 ring-slate-200 dark:bg-[#202428] dark:text-slate-300 dark:ring-[#343a40]">
          <MaterialIcon name={icon} size={15} />
        </span>
        <h2 className="kodeks-ui-label text-slate-800 dark:text-slate-100">
          {title}
        </h2>
      </div>
      {children}
    </section>
  );
}

// 渲染开关状态，保持右侧调试面板的 Chrome-like 控件密度。
function StatusSwitch({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={`relative h-6 w-11 rounded-full ${enabled ? "bg-blue-600" : "bg-slate-300 dark:bg-slate-700"}`}
    >
      <span
        className={`absolute top-1 size-4 rounded-full bg-white transition ${enabled ? "left-6" : "left-1"}`}
      />
    </span>
  );
}

// 渲染一个紧凑的只读配置行。
function ReadonlyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[84px_minmax(0,1fr)] items-center gap-2">
      <span className="kodeks-ui-caption text-slate-500 dark:text-slate-400">
        {label}
      </span>
      <div className="kodeks-code-text min-w-0 truncate rounded-[10px] border border-slate-200 bg-white px-2.5 py-2 text-slate-500 shadow-sm dark:border-[#343a40] dark:bg-[#202428] dark:text-slate-400 dark:shadow-none">
        {value}
      </div>
    </div>
  );
}

// 渲染配置文件中的 provider/model 选择；MoonBridge 只作为状态，不作为用户选择项。
function ModelSelector({
  copy,
  selectedModel,
  modelOptions,
  onModelChange,
}: {
  copy: UiCopy["tools"];
  selectedModel: string;
  modelOptions: ConfiguredModelOption[];
  onModelChange: (model: string) => void;
}) {
  const providerIds = Array.from(
    new Set(modelOptions.map((option) => option.providerId)),
  );
  const selectedOption =
    modelOptions.find((option) => option.ref === selectedModel) ??
    modelOptions[0];
  const selectedProviderId = selectedOption?.providerId ?? providerIds[0] ?? "";
  const providerModels = modelOptions.filter(
    (option) => option.providerId === selectedProviderId,
  );

  return (
    <div className="grid grid-cols-2 gap-2">
      <label className="min-w-0">
        <span className="kodeks-ui-caption mb-2 block text-slate-500 dark:text-slate-400">
          {copy.provider}
        </span>
        <select
          className="kodeks-control-text w-full rounded-[10px] border border-slate-200 bg-white px-3 py-2 text-slate-600 shadow-sm dark:border-[#343a40] dark:bg-[#202428] dark:text-slate-300 dark:shadow-none"
          onChange={(event) => {
            const nextModel = modelOptions.find(
              (option) => option.providerId === event.target.value,
            );
            if (nextModel !== undefined) {
              onModelChange(nextModel.ref);
            }
          }}
          value={selectedProviderId}
        >
          {providerIds.map((providerId) => (
            <option key={providerId} value={providerId}>
              {providerId}
            </option>
          ))}
        </select>
      </label>
      <label className="min-w-0">
        <span className="kodeks-ui-caption mb-2 block text-slate-500 dark:text-slate-400">
          {copy.model}
        </span>
        <select
          className="kodeks-control-text w-full rounded-[10px] border border-slate-200 bg-white px-3 py-2 text-slate-600 shadow-sm dark:border-[#343a40] dark:bg-[#202428] dark:text-slate-300 dark:shadow-none"
          onChange={(event) => onModelChange(event.target.value)}
          value={selectedOption?.ref ?? ""}
        >
          {providerModels.map((option) => (
            <option key={option.ref} value={option.ref}>
              {option.modelName}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

// 生成 MoonBridge 预检卡片的主状态文案，保持中英文 copy 都由 UI 层控制。
function formatBridgeStatusTitle(
  preflight: MoonBridgePreflightView,
  copy: UiCopy["tools"],
): string {
  if (preflight.status === "checking") {
    return copy.bridgeChecking;
  }
  if (preflight.status === "ready") {
    return copy.bridgeReady;
  }
  if (preflight.status === "not_required") {
    return copy.bridgeNotRequired;
  }
  return copy.bridgeUnavailable;
}

// 生成 MoonBridge 预检说明，优先展示服务端给出的具体失败原因。
function formatBridgeStatusMessage(
  preflight: MoonBridgePreflightView,
  copy: UiCopy["tools"],
): string {
  if (preflight.status === "checking") {
    return copy.bridgeCheckingMessage;
  }
  if (preflight.status === "ready") {
    return preflight.reason ?? copy.bridgeReadyMessage;
  }
  if (preflight.status === "not_required") {
    return copy.bridgeNotRequiredMessage;
  }
  return preflight.reason ?? copy.bridgeUnavailableMessage;
}

// 渲染当前 provider 的 MoonBridge 预检结果，并提供手动刷新入口。
function BridgeHealthPanel({
  copy,
  preflight,
  onRefresh,
}: {
  copy: UiCopy["tools"];
  preflight: MoonBridgePreflightView;
  onRefresh?: () => void;
}) {
  const tone = bridgeStatusTone[preflight.status];
  const resolvedProvider =
    "resolvedProvider" in preflight ? preflight.resolvedProvider : undefined;
  const bridgeBaseURL =
    "bridgeBaseURL" in preflight ? preflight.bridgeBaseURL : undefined;
  const upstreamBaseURL =
    "upstreamBaseURL" in preflight ? preflight.upstreamBaseURL : undefined;
  const bridgeModel =
    "bridgeModel" in preflight
      ? (preflight.upstreamModel ?? preflight.bridgeModel)
      : undefined;
  const reason = "reason" in preflight ? preflight.reason : undefined;

  return (
    <div className="space-y-3">
      <div
        className={`rounded-[12px] bg-white p-3 ring-1 ${tone.ring} dark:bg-[#202428]`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div
              className={`kodeks-ui-label flex items-center gap-2 ${tone.text}`}
            >
              <span className={`size-2.5 rounded-full ${tone.dot}`} />
              <span>{formatBridgeStatusTitle(preflight, copy)}</span>
            </div>
            <p className="kodeks-ui-caption mt-1 text-slate-500 dark:text-slate-400">
              {formatBridgeStatusMessage(preflight, copy)}
            </p>
          </div>
          <button
            aria-label={copy.bridgeRefresh}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-[10px] text-slate-500 transition hover:bg-slate-100 hover:text-slate-950 dark:text-slate-400 dark:hover:bg-[#2b3035] dark:hover:text-white"
            onClick={onRefresh}
            type="button"
          >
            <MaterialIcon name="refresh" size={16} />
          </button>
        </div>
      </div>
      <ReadonlyRow
        label={copy.provider}
        value={resolvedProvider ?? preflight.provider}
      />
      <ReadonlyRow
        label={copy.bridgeEndpoint}
        value={bridgeBaseURL ?? copy.notConfigured}
      />
      <ReadonlyRow
        label={copy.bridgeUpstream}
        value={upstreamBaseURL ?? copy.notConfigured}
      />
      <ReadonlyRow
        label={copy.bridgeModel}
        value={bridgeModel ?? copy.notConfigured}
      />
      {reason !== undefined && reason.trim().length > 0 ? (
        <ReadonlyRow label={copy.bridgeReason} value={reason} />
      ) : null}
    </div>
  );
}

// 渲染右侧 NotebookLM-style 的折叠工具 rail，保留设置功能的图标入口。
function CollapsedToolsRail({
  copy,
  onCollapseToggle,
}: {
  copy: UiCopy["tools"];
  onCollapseToggle?: () => void;
}) {
  return (
    <aside
      className="flex h-full min-h-0 w-full flex-col items-center overflow-hidden rounded-[16px] border border-slate-200 bg-white py-3 text-slate-800 shadow-sm dark:border-[#343a40] dark:bg-[#202428] dark:text-slate-100 dark:shadow-none"
      data-testid="tools-panel"
      data-state="collapsed"
    >
      <button
        aria-label={copy.expandSidebar}
        className="mb-5 inline-flex size-9 items-center justify-center rounded-[10px] text-slate-600 transition hover:bg-slate-100 hover:text-slate-950 dark:text-slate-300 dark:hover:bg-[#2b3035] dark:hover:text-white"
        data-testid="tools-expand-button"
        onClick={onCollapseToggle}
        type="button"
      >
        <MaterialIcon name="dock_to_left" size={18} />
      </button>
      <div className="flex flex-1 flex-col items-center gap-3">
        {railToolEntries.map((entry) => (
          <button
            aria-label={copy.preferences}
            className={`inline-flex size-9 items-center justify-center rounded-[10px] transition hover:brightness-95 ${entry.tone}`}
            key={entry.icon}
            type="button"
          >
            <MaterialIcon name={entry.icon} size={18} />
          </button>
        ))}
      </div>
    </aside>
  );
}

// 渲染 Kodeks 右侧调试面板，像 Chrome 自定义侧栏一样组织设置和诊断功能。
export default function ToolsPanel({
  collapsed = false,
  mode,
  selectedModel,
  modelOptions,
  bridgePreflight,
  reasoningEffort = "medium",
  sessionId,
  activityCount,
  copy,
  language,
  theme,
  onLanguageChange,
  onModeChange,
  onModelChange,
  onBridgePreflightRefresh,
  onReasoningEffortChange,
  onCollapseToggle,
  onThemeChange,
}: ToolsPanelProps) {
  if (collapsed) {
    return (
      <CollapsedToolsRail copy={copy} onCollapseToggle={onCollapseToggle} />
    );
  }

  return (
    <aside
      className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-[16px] border border-slate-200 bg-white text-slate-950 shadow-sm dark:border-[#343a40] dark:bg-[#202428] dark:text-slate-100 dark:shadow-none"
      data-testid="tools-panel"
      data-state="expanded"
    >
      <div className="flex h-14 shrink-0 items-center justify-between px-4">
        <h1 className="kodeks-ui-title">{copy.debugPanel}</h1>
        <button
          aria-label={copy.collapseSidebar}
          className="inline-flex size-8 items-center justify-center rounded-[10px] text-slate-500 transition hover:bg-slate-100 hover:text-slate-950 dark:text-slate-400 dark:hover:bg-[#2b3035] dark:hover:text-white"
          data-testid="tools-collapse-button"
          onClick={onCollapseToggle}
          type="button"
        >
          <MaterialIcon name="dock_to_right" size={17} />
        </button>
      </div>

      <div className="kodeks-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-4">
        <DebugSection icon="hub" title={copy.bridgeHealth}>
          <BridgeHealthPanel
            copy={copy}
            onRefresh={onBridgePreflightRefresh}
            preflight={bridgePreflight}
          />
        </DebugSection>

        <DebugSection icon="smart_toy" title={copy.appearancePreview}>
          <div className="rounded-[14px] bg-blue-100 p-2 dark:bg-[#30343a]">
            <div className="rounded-[14px] bg-white p-3 text-slate-500 shadow-sm ring-1 ring-slate-200 dark:bg-[#202428] dark:text-slate-400 dark:ring-[#343a40] dark:shadow-none">
              <div className="mb-3 flex items-center gap-2">
                <span className="size-6 rounded-[10px] bg-slate-200 dark:bg-[#343a40]" />
                <span className="h-3 min-w-0 flex-1 rounded-full bg-slate-200 dark:bg-[#343a40]" />
              </div>
              <div className="grid grid-cols-[24px_24px_24px_minmax(0,1fr)] gap-2">
                <span className="h-6 rounded-[10px] bg-blue-100 dark:bg-[#3a4050]" />
                <span className="h-6 rounded-[10px] bg-emerald-100 dark:bg-[#34463d]" />
                <span className="h-6 rounded-[10px] bg-amber-100 dark:bg-[#4a4431]" />
                <span className="h-6 rounded-full bg-slate-100 dark:bg-[#2b3035]" />
              </div>
            </div>
          </div>
          <div className="space-y-3">
            <SegmentedControl
              onChange={onThemeChange}
              options={[
                { value: "light", label: copy.light },
                { value: "dark", label: copy.dark },
                { value: "system", label: copy.device },
              ]}
              value={theme}
            />
            <SegmentedControl
              onChange={onLanguageChange}
              options={[
                { value: "zh", label: "中文" },
                { value: "en", label: "EN" },
                { value: "system", label: copy.device },
              ]}
              value={language}
            />
          </div>
        </DebugSection>

        <DebugSection icon="terminal" title={copy.runtimeSettings}>
          <div className="space-y-3">
            <ModelSelector
              copy={copy}
              modelOptions={modelOptions}
              onModelChange={onModelChange}
              selectedModel={selectedModel}
            />
            <div className="flex items-center justify-between gap-3">
              <label
                className="kodeks-ui-caption text-slate-500 dark:text-slate-400"
                htmlFor="reasoning-effort-select"
              >
                {copy.reasoning}
              </label>
              <select
                className="kodeks-control-text rounded-[10px] border border-slate-200 bg-white px-3 py-2 text-slate-600 shadow-sm dark:border-[#343a40] dark:bg-[#202428] dark:text-slate-300 dark:shadow-none"
                id="reasoning-effort-select"
                onChange={(event) =>
                  onReasoningEffortChange?.(
                    event.target.value as typeof reasoningEffort,
                  )
                }
                value={reasoningEffort}
              >
                <option value="low">{copy.reasoningOptions.low}</option>
                <option value="medium">{copy.reasoningOptions.medium}</option>
                <option value="high">{copy.reasoningOptions.high}</option>
                <option value="xhigh">{copy.reasoningOptions.xhigh}</option>
              </select>
            </div>
            <ReadonlyRow
              label={copy.session}
              value={sessionId || copy.autoSession}
            />
            <ReadonlyRow
              label={copy.runtimeEvents}
              value={String(activityCount)}
            />
          </div>
        </DebugSection>

        <DebugSection icon="code" title={copy.codeInterpreter}>
          <div className="flex items-center justify-between gap-3">
            <div className="kodeks-control-text inline-flex rounded-full border border-slate-200 bg-slate-100 p-1 text-slate-600 dark:border-[#343a40] dark:bg-[#1b1d21] dark:text-slate-300">
              <button
                className={`min-w-12 rounded-full px-3 py-1 transition ${mode === "act" ? "bg-white text-slate-950 shadow-sm dark:bg-[#30353b] dark:text-white" : ""}`}
                onClick={() => onModeChange("act")}
                type="button"
              >
                {copy.act}
              </button>
              <button
                className={`min-w-12 rounded-full px-3 py-1 transition ${mode === "plan" ? "bg-white text-slate-950 shadow-sm dark:bg-[#30353b] dark:text-white" : ""}`}
                onClick={() => onModeChange("plan")}
                type="button"
              >
                {copy.plan}
              </button>
            </div>
            <StatusSwitch enabled={mode === "act"} />
          </div>
        </DebugSection>

        <DebugSection icon="memory" title={copy.functions}>
          <div className="space-y-2">
            {defaultToolDefinitions.map((tool) => (
              <div
                className="kodeks-code-text flex items-start gap-2 text-slate-700 dark:text-slate-300"
                key={tool.name}
              >
                <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-[10px] bg-blue-100 text-blue-600 dark:bg-[#30343a] dark:text-slate-300">
                  <MaterialIcon name="code" size={13} />
                </span>
                <span className="min-w-0 break-words">
                  {formatToolSignature(tool)}
                </span>
              </div>
            ))}
          </div>
        </DebugSection>

        <DebugSection icon="account_tree" title={copy.mcp}>
          <p className="kodeks-ui-caption text-slate-500 dark:text-slate-400">
            {copy.mcpDescription}
          </p>
          <ReadonlyRow label={copy.mcpManifest} value="list_mcp_servers()" />
        </DebugSection>

        <DebugSection icon="shield" title={copy.skills}>
          <p className="kodeks-ui-caption text-slate-500 dark:text-slate-400">
            {copy.skillsDescription}
          </p>
          <ReadonlyRow label={copy.skillSource} value="list_skills()" />
        </DebugSection>
      </div>
    </aside>
  );
}
