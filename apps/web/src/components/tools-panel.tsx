'use client';

import React from 'react';

import type { ModelProviderOverride } from '@kodeks/model';
import {
  defaultToolDefinitions,
  type JsonSchemaProperty,
  type ToolDefinition
} from '@kodeks/tools/definitions';

import { MaterialIcon } from '@/components/material-icon';
import type {
  UiCopy,
  UiLanguagePreference,
  UiThemePreference
} from '@/lib/ui-copy';

type ToolsPanelProps = {
  mode: 'act' | 'plan';
  provider: ModelProviderOverride;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  sessionId: string;
  activityCount: number;
  copy: UiCopy['tools'];
  language: UiLanguagePreference;
  theme: UiThemePreference;
  onLanguageChange: (language: UiLanguagePreference) => void;
  onModeChange: (mode: 'act' | 'plan') => void;
  onProviderChange: (provider: ModelProviderOverride) => void;
  onReasoningEffortChange?: (
    effort: 'low' | 'medium' | 'high' | 'xhigh'
  ) => void;
  onThemeChange: (theme: UiThemePreference) => void;
};

type SegmentOption<TValue extends string> = {
  value: TValue;
  label: string;
};

// Converts JSON schema primitive names into the compact labels shown in the tool list.
function formatSchemaType(property: JsonSchemaProperty | undefined): string {
  if (property === undefined) {
    return 'unknown';
  }
  if (Array.isArray(property.type)) {
    return property.type.join(' | ');
  }
  if (property.type !== undefined) {
    return property.type;
  }
  if (property.enum !== undefined) {
    return 'string';
  }
  if (property.properties !== undefined) {
    return 'object';
  }
  if (property.items !== undefined) {
    return 'array';
  }
  return 'unknown';
}

// Renders a provider-facing tool definition as a TypeScript-like function signature.
export function formatToolSignature(tool: ToolDefinition): string {
  const required = new Set(tool.parameters.required ?? []);
  const parameters = Object.entries(tool.parameters.properties).map(
    ([name, property]) => {
      const optionalMarker = required.has(name) ? '' : '?';
      return `${name}${optionalMarker}: ${formatSchemaType(property)}`;
    }
  );
  return `${tool.name}(${parameters.join(', ')})`;
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
      className="kodeks-control-text grid rounded-full bg-zinc-200 p-1 text-zinc-600 dark:bg-zinc-950 dark:text-zinc-300"
      style={{
        gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))`
      }}
    >
      {options.map((option) => {
        const isSelected = option.value === value;
        return (
          <button
            aria-pressed={isSelected}
            className={`rounded-full px-2 py-1.5 transition ${
              isSelected
                ? 'bg-white text-zinc-950 shadow-sm dark:bg-zinc-700 dark:text-white'
                : 'hover:text-zinc-950 dark:hover:text-white'
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

// 渲染 Chrome 自定义面板风格的右栏区块。
function DebugSection({
  title,
  icon,
  children
}: {
  title: string;
  icon: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-lg bg-zinc-100 p-3 dark:bg-zinc-900">
      <div className="flex items-center gap-2">
        <span className="inline-flex size-7 items-center justify-center rounded-md bg-white text-zinc-600 shadow-sm dark:bg-zinc-800 dark:text-zinc-200">
          <MaterialIcon name={icon} size={15} />
        </span>
        <h2 className="kodeks-ui-label text-zinc-800 dark:text-zinc-100">
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
      className={`relative h-6 w-11 rounded-full ${enabled ? 'bg-blue-600' : 'bg-zinc-300 dark:bg-zinc-700'}`}
    >
      <span
        className={`absolute top-1 size-4 rounded-full bg-white transition ${enabled ? 'left-6' : 'left-1'}`}
      />
    </span>
  );
}

// 渲染一个紧凑的只读配置行。
function ReadonlyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[84px_minmax(0,1fr)] items-center gap-2">
      <span className="kodeks-ui-caption text-zinc-500 dark:text-zinc-400">
        {label}
      </span>
      <div className="kodeks-code-text min-w-0 truncate rounded-md border border-stone-200 bg-white px-2.5 py-2 text-zinc-500 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
        {value}
      </div>
    </div>
  );
}

// 渲染 Kodeks 右侧调试面板，像 Chrome 自定义侧栏一样组织设置和诊断功能。
export default function ToolsPanel({
  mode,
  provider,
  reasoningEffort = 'medium',
  sessionId,
  activityCount,
  copy,
  language,
  theme,
  onLanguageChange,
  onModeChange,
  onProviderChange,
  onReasoningEffortChange,
  onThemeChange
}: ToolsPanelProps) {
  return (
    <aside
      className="flex h-full min-h-0 w-full flex-col border border-stone-200 bg-zinc-50 text-zinc-950 dark:border-zinc-800 dark:bg-[#191919] dark:text-zinc-50"
      data-testid="tools-panel"
    >
      <div className="flex h-14 shrink-0 items-center justify-between px-4">
        <h1 className="kodeks-ui-title">{copy.debugPanel}</h1>
        <button
          aria-label={copy.preferences}
          className="inline-flex size-8 items-center justify-center rounded-md text-zinc-500 transition hover:bg-zinc-200 hover:text-zinc-950 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-50"
          type="button"
        >
          <MaterialIcon name="tune" size={17} />
        </button>
      </div>

      <div className="kodeks-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-4">
        <DebugSection icon="smart_toy" title={copy.appearancePreview}>
          <div className="rounded-lg bg-blue-600 p-2">
            <div className="rounded-md bg-zinc-800 p-3 text-zinc-200 shadow-sm">
              <div className="mb-3 flex items-center gap-2">
                <span className="size-6 rounded-md bg-zinc-700" />
                <span className="h-3 min-w-0 flex-1 rounded-full bg-zinc-700" />
              </div>
              <div className="grid grid-cols-[24px_24px_24px_minmax(0,1fr)] gap-2">
                <span className="h-6 rounded bg-zinc-700" />
                <span className="h-6 rounded bg-zinc-700" />
                <span className="h-6 rounded bg-zinc-700" />
                <span className="h-6 rounded-full bg-zinc-900" />
              </div>
            </div>
          </div>
          <div className="space-y-3">
            <SegmentedControl
              onChange={onThemeChange}
              options={[
                { value: 'light', label: copy.light },
                { value: 'dark', label: copy.dark },
                { value: 'system', label: copy.device }
              ]}
              value={theme}
            />
            <SegmentedControl
              onChange={onLanguageChange}
              options={[
                { value: 'zh', label: '中文' },
                { value: 'en', label: 'EN' },
                { value: 'system', label: copy.device }
              ]}
              value={language}
            />
          </div>
        </DebugSection>

        <DebugSection icon="terminal" title={copy.runtimeSettings}>
          <div className="space-y-3">
            <div>
              <div className="kodeks-ui-caption mb-2 text-zinc-500 dark:text-zinc-400">
                {copy.provider}
              </div>
              <SegmentedControl
                onChange={onProviderChange}
                options={[
                  { value: 'openai', label: 'OpenAI' },
                  { value: 'moonbridge', label: 'MoonBridge' },
                  { value: 'deepseek', label: 'DeepSeek' }
                ]}
                value={provider}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <label
                className="kodeks-ui-caption text-zinc-500 dark:text-zinc-400"
                htmlFor="reasoning-effort-select"
              >
                {copy.reasoning}
              </label>
              <select
                className="kodeks-control-text rounded-md border border-stone-200 bg-white px-3 py-2 text-zinc-600 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200"
                id="reasoning-effort-select"
                onChange={(event) =>
                  onReasoningEffortChange?.(
                    event.target.value as typeof reasoningEffort
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
            <div className="kodeks-control-text inline-flex rounded-full bg-zinc-200 p-1 text-zinc-600 dark:bg-zinc-950 dark:text-zinc-300">
              <button
                className={`min-w-12 rounded-full px-3 py-1 transition ${mode === 'act' ? 'bg-white text-zinc-950 shadow-sm dark:bg-zinc-700 dark:text-white' : ''}`}
                onClick={() => onModeChange('act')}
                type="button"
              >
                {copy.act}
              </button>
              <button
                className={`min-w-12 rounded-full px-3 py-1 transition ${mode === 'plan' ? 'bg-white text-zinc-950 shadow-sm dark:bg-zinc-700 dark:text-white' : ''}`}
                onClick={() => onModeChange('plan')}
                type="button"
              >
                {copy.plan}
              </button>
            </div>
            <StatusSwitch enabled={mode === 'act'} />
          </div>
        </DebugSection>

        <DebugSection icon="public" title={copy.webSearch}>
          <p className="kodeks-ui-caption text-zinc-500 dark:text-zinc-400">
            {copy.webSearchDescription}
          </p>
          <ReadonlyRow label={copy.braveProvider} value="BRAVE_SEARCH_API_KEY" />
          <ReadonlyRow label={copy.region} value={copy.workspaceOnly} />
          <ReadonlyRow label={copy.city} value={copy.notConfigured} />
        </DebugSection>

        <DebugSection icon="memory" title={copy.functions}>
          <div className="space-y-2">
            {defaultToolDefinitions.map((tool) => (
              <div
                className="kodeks-code-text flex items-start gap-2 text-zinc-700 dark:text-zinc-300"
                key={tool.name}
              >
                <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-blue-100 text-blue-500 dark:bg-blue-500/15 dark:text-blue-300">
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
          <p className="kodeks-ui-caption text-zinc-500 dark:text-zinc-400">
            {copy.mcpDescription}
          </p>
          <ReadonlyRow label={copy.mcpManifest} value="list_mcp_servers()" />
        </DebugSection>

        <DebugSection icon="shield" title={copy.skills}>
          <p className="kodeks-ui-caption text-zinc-500 dark:text-zinc-400">
            {copy.skillsDescription}
          </p>
          <ReadonlyRow label={copy.skillSource} value="list_skills()" />
        </DebugSection>
      </div>
    </aside>
  );
}
