"use client";

import React from "react";

import { defaultToolDefinitions, type JsonSchemaProperty, type ToolDefinition } from "@kodeks/tools/definitions";

import { MaterialIcon } from "@/components/material-icon";
import type { UiCopy, UiLanguagePreference, UiThemePreference } from "@/lib/ui-copy";

type ToolsPanelProps = {
  mode: "act" | "plan";
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  sessionId: string;
  activityCount: number;
  copy: UiCopy["tools"];
  language: UiLanguagePreference;
  theme: UiThemePreference;
  onLanguageChange: (language: UiLanguagePreference) => void;
  onModeChange: (mode: "act" | "plan") => void;
  onReasoningEffortChange?: (effort: "low" | "medium" | "high" | "xhigh") => void;
  onThemeChange: (theme: UiThemePreference) => void;
};

type SegmentOption<TValue extends string> = {
  value: TValue;
  label: string;
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
  const parameters = Object.entries(tool.parameters.properties).map(([name, property]) => {
    const optionalMarker = required.has(name) ? "" : "?";
    return `${name}${optionalMarker}: ${formatSchemaType(property)}`;
  });
  return `${tool.name}(${parameters.join(", ")})`;
}

// 渲染一组分段按钮，用 key 固定每个选项，避免切换语言时旧选中态残留。
function SegmentedControl<TValue extends string>({
  value,
  options,
  onChange
}: {
  value: TValue;
  options: Array<SegmentOption<TValue>>;
  onChange: (value: TValue) => void;
}) {
  return (
    <div
      className="grid rounded-full bg-zinc-200 p-1 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((option) => {
        const isSelected = option.value === value;
        return (
          <button
            aria-pressed={isSelected}
            className={`rounded-full px-2 py-1.5 ${isSelected ? "bg-white text-zinc-950 shadow-sm dark:bg-zinc-950 dark:text-white" : ""}`}
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

// 渲染工具面板里的一个配置区块，并展示右侧开关状态。
function PanelConfig({
  title,
  enabled,
  children
}: {
  title: string;
  enabled: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="font-medium text-zinc-950 dark:text-zinc-50">{title}</h1>
        <span className={`relative h-6 w-11 rounded-full ${enabled ? "bg-zinc-950 dark:bg-zinc-50" : "bg-slate-200 dark:bg-zinc-700"}`}>
          <span className={`absolute top-1 size-4 rounded-full ${enabled ? "bg-white dark:bg-zinc-950" : "bg-white"} transition ${enabled ? "left-6" : "left-1"}`} />
        </span>
      </div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

// 渲染 Kodeks 工具面板，所有展示文案都从上层语言配置传入。
export default function ToolsPanel({
  mode,
  reasoningEffort = "medium",
  sessionId,
  activityCount,
  copy,
  language,
  theme,
  onLanguageChange,
  onModeChange,
  onReasoningEffortChange,
  onThemeChange
}: ToolsPanelProps) {
  return (
    <div
      className="h-full min-h-0 w-full rounded-t-xl border-r border-stone-100 bg-zinc-50 p-6 text-zinc-950 md:rounded-none md:p-8 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50"
      data-testid="tools-panel"
    >
      <div className="kodeks-scrollbar flex h-full flex-col overflow-y-scroll">
        <PanelConfig enabled title={copy.preferences}>
          <div className="space-y-4 text-sm">
            <div>
              <div className="mb-2 font-medium text-zinc-600 dark:text-zinc-300">{copy.language}</div>
              <SegmentedControl
                onChange={onLanguageChange}
                options={[
                  { value: "system", label: copy.system },
                  { value: "zh", label: "中文" },
                  { value: "en", label: "EN" }
                ]}
                value={language}
              />
            </div>
            <div>
              <div className="mb-2 font-medium text-zinc-600 dark:text-zinc-300">{copy.theme}</div>
              <SegmentedControl
                onChange={onThemeChange}
                options={[
                  { value: "system", label: copy.system },
                  { value: "light", label: copy.light },
                  { value: "dark", label: copy.dark }
                ]}
                value={theme}
              />
            </div>
          </div>
        </PanelConfig>

        <PanelConfig enabled title={copy.fileSearch}>
          <p className="mb-4 text-sm leading-5 text-zinc-500 dark:text-zinc-400">{copy.fileSearchDescription}</p>
          <div className="flex items-center gap-4">
            <span className="font-medium text-zinc-900 dark:text-zinc-100">{copy.session}</span>
            <div className="min-w-0 flex-1 rounded-md border border-stone-200 bg-white px-3 py-2 text-sm text-zinc-500 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
              {sessionId || copy.autoSession}
            </div>
          </div>
        </PanelConfig>

        <PanelConfig enabled title={copy.webSearch}>
          <p className="mb-4 text-sm leading-5 text-zinc-500 dark:text-zinc-400">{copy.webSearchDescription}</p>
          <div className="flex items-center gap-4 text-sm">
            <span className="font-medium text-zinc-900 dark:text-zinc-100">{copy.braveProvider}</span>
            <div className="min-w-0 flex-1 rounded-md border border-stone-200 bg-white px-3 py-2 text-zinc-500 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
              BRAVE_SEARCH_API_KEY
            </div>
          </div>
          <div className="mt-4 grid grid-cols-[96px_minmax(0,1fr)] items-center gap-3 text-sm">
            <span className="text-zinc-400">{copy.country}</span>
            <div className="rounded-md border border-stone-200 bg-white px-3 py-2 text-zinc-400 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">web_search(country)</div>
            <span className="text-zinc-400">{copy.region}</span>
            <div className="rounded-md border border-stone-200 bg-white px-3 py-2 text-zinc-400 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">{copy.workspaceOnly}</div>
            <span className="text-zinc-400">{copy.city}</span>
            <div className="rounded-md border border-stone-200 bg-white px-3 py-2 text-zinc-400 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">{copy.notConfigured}</div>
          </div>
        </PanelConfig>

        <PanelConfig enabled={mode === "act"} title={copy.codeInterpreter}>
          <div className="inline-flex w-fit rounded-full bg-zinc-200 p-1 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
            <button
              className={`min-w-12 rounded-full px-3 py-1 ${mode === "act" ? "bg-white text-zinc-950 shadow-sm dark:bg-zinc-950 dark:text-white" : ""}`}
              onClick={() => onModeChange("act")}
              type="button"
            >
              {copy.act}
            </button>
            <button
              className={`min-w-12 rounded-full px-3 py-1 ${mode === "plan" ? "bg-white text-zinc-950 shadow-sm dark:bg-zinc-950 dark:text-white" : ""}`}
              onClick={() => onModeChange("plan")}
              type="button"
            >
              {copy.plan}
            </button>
          </div>
        </PanelConfig>

        <PanelConfig enabled title={copy.functions}>
          <div className="space-y-5">
            {defaultToolDefinitions.map((tool) => (
              <div className="flex items-start gap-3 font-mono text-sm text-zinc-700 dark:text-zinc-300" key={tool.name}>
                <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-blue-100 text-blue-500 dark:bg-blue-500/15 dark:text-blue-300">
                  <MaterialIcon name="code" size={16} />
                </span>
                <span>{formatToolSignature(tool)}</span>
              </div>
            ))}
          </div>
        </PanelConfig>

        <PanelConfig enabled title={copy.mcp}>
          <p className="mb-4 text-sm leading-5 text-zinc-500 dark:text-zinc-400">{copy.mcpDescription}</p>
          <div className="flex items-center gap-4 text-sm">
            <span className="font-medium text-zinc-900 dark:text-zinc-100">{copy.mcpManifest}</span>
            <div className="min-w-0 flex-1 rounded-md border border-stone-200 bg-white px-3 py-2 text-zinc-500 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
              list_mcp_servers()
            </div>
          </div>
        </PanelConfig>

        <PanelConfig enabled title={copy.skills}>
          <p className="mb-4 text-sm leading-5 text-zinc-500 dark:text-zinc-400">{copy.skillsDescription}</p>
          <div className="flex items-center gap-4 text-sm">
            <span className="font-medium text-zinc-900 dark:text-zinc-100">{copy.skillSource}</span>
            <div className="min-w-0 flex-1 rounded-md border border-stone-200 bg-white px-3 py-2 text-zinc-500 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
              list_skills() / read_skill()
            </div>
          </div>
        </PanelConfig>

        <PanelConfig enabled title={copy.runtimeSettings}>
          <div className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-zinc-500 dark:text-zinc-400">{copy.reasoning}</span>
              <select
                className="rounded-md border border-stone-200 bg-white px-3 py-2 text-zinc-600 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"
                onChange={(event) => onReasoningEffortChange?.(event.target.value as typeof reasoningEffort)}
                value={reasoningEffort}
              >
                <option value="low">{copy.reasoningOptions.low}</option>
                <option value="medium">{copy.reasoningOptions.medium}</option>
                <option value="high">{copy.reasoningOptions.high}</option>
                <option value="xhigh">{copy.reasoningOptions.xhigh}</option>
              </select>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-zinc-500 dark:text-zinc-400">{copy.runtimeEvents}</span>
              <span className="font-medium text-zinc-900 dark:text-zinc-100">{activityCount}</span>
            </div>
          </div>
        </PanelConfig>

        <PanelConfig enabled={false} title={copy.googleIntegration}>
          <button className="rounded-full border border-stone-200 bg-white px-4 py-2 text-sm font-medium text-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-600" disabled type="button">
            {copy.connectGoogle}
          </button>
        </PanelConfig>
      </div>
    </div>
  );
}
