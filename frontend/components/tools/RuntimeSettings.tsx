"use client";

// frontend/components/tools/RuntimeSettings.tsx
// 运行设置控件（Task 4.6）：provider 下拉 + model 下拉 + reasoning 下拉 + mode 切换。
// 数据来源：useModels（目录/provider 派生）与 chat-store（mode/model/providerId/reasoning）。
//
// HIG / 无障碍要点：
//   - 每个 Select 都有可见的 <label> 文案，并通过 aria-label 显式命名 trigger
//     （Base UI 的 Select.Trigger 是按钮，需自带可达名称——修复审计中
//      “segmented controls lack aria-label” 的发现）。
//   - mode 用 ToggleGroup（单选），整组通过 aria-label 命名其用途；
//     当前值由 primitive 的 pressed/selected 态传达，不靠颜色单一信号。
//   - 触控目标：Select trigger 与 ToggleGroupItem 高度 ≥ 44px（h-11）。
//
// Base UI 选型说明：
//   - Select.Root 为受控用法：value=string、onValueChange(value)；传入 items 后
//     <Select.Value> 会以 label 渲染选中项。这里 items 用 {value: label} 字典。
//   - ToggleGroup 的 value 是「字符串数组」（单选即长度 1 的数组），
//     onValueChange 回调亦给出数组——取首元素写回 store。

import { useId } from "react";
import { SlidersHorizontal } from "lucide-react";

import { useI18n } from "@/components/providers/I18nProvider";
import { useChatStore } from "@/stores/chat-store";
import { useModels } from "@/hooks/useModels";
import type { Mode, Reasoning } from "@/stores/chat-store";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

/** 单个「下拉项」的形状：value 写回 store，label 用于展示。 */
interface Option {
  value: string;
  label: string;
}

/**
 * 带可见标签的受控 Select 封装。
 * 标签经由 htmlFor/id 关联到 trigger，trigger 另带 aria-label 双保险（满足 HIG
 * “每个 Select 有可见标签或 aria-label”）。items 同时喂给 Select.Root，
 * 使 <SelectValue> 能以 label 而非裸 value 渲染选中项。
 * @param label       可见标签文案（同时作为 aria-label）。
 * @param value       当前选中值（受控）。
 * @param options     可选项列表。
 * @param onChange    选中变化回调（已解包为字符串值）。
 * @param placeholder 未选中时的占位文案。
 * @param disabled    是否禁用（如目录为空时）。
 */
function LabeledSelect({
  label,
  value,
  options,
  onChange,
  placeholder,
  disabled,
}: {
  label: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const triggerId = useId();
  // items 字典：让 Select.Value 以 label 渲染选中项（Base UI items 约定）。
  const items = Object.fromEntries(options.map((o) => [o.value, o.label]));
  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={triggerId}
        className="px-1 text-xs font-medium text-muted-foreground"
      >
        {label}
      </label>
      <Select
        items={items}
        value={value || null}
        onValueChange={(next) => {
          if (typeof next === "string") onChange(next);
        }}
        disabled={disabled}
      >
        <SelectTrigger
          id={triggerId}
          aria-label={label}
          className="h-11 w-full"
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * 运行设置面板。
 * 把 useModels 与 chat-store 接线为四个控件：provider / model / reasoning / mode。
 * 切换 provider 时会顺带把 model 重选为「该 provider 的首个模型」，保证两者一致。
 */
export function RuntimeSettings() {
  const { t } = useI18n();
  const { providers, modelsForCurrentProvider, models, loading } = useModels();

  // 细粒度订阅：仅在相关字段变化时重渲染。
  const providerId = useChatStore((s) => s.providerId);
  const model = useChatStore((s) => s.model);
  const reasoning = useChatStore((s) => s.reasoning);
  const mode = useChatStore((s) => s.mode);
  const setSettings = useChatStore((s) => s.setSettings);

  // provider 下拉项：去重后的 provider 列表。
  const providerOptions: Option[] = providers.map((p) => ({
    value: p.id,
    label: p.name,
  }));

  // model 下拉项：限定为当前 provider 下的模型，value=ref、label=modelName。
  const modelOptions: Option[] = modelsForCurrentProvider.map((m) => ({
    value: m.ref,
    label: m.modelName,
  }));

  // reasoning 下拉项：固定四档，标签取 i18n。
  const reasoningOptions: Option[] = [
    { value: "low", label: t.reasoningOptions.low },
    { value: "medium", label: t.reasoningOptions.medium },
    { value: "high", label: t.reasoningOptions.high },
    { value: "xhigh", label: t.reasoningOptions.xhigh },
  ];

  /**
   * 切换 provider：写回 providerId，并把 model 重选为该 provider 的首个模型，
   * 避免出现「model 仍属于旧 provider」的不一致。
   */
  const handleProviderChange = (nextProviderId: string) => {
    const first = models.find((m) => m.providerId === nextProviderId);
    setSettings({
      providerId: nextProviderId,
      model: first ? first.ref : "",
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <LabeledSelect
        label={t.provider}
        value={providerId}
        options={providerOptions}
        onChange={handleProviderChange}
        placeholder={loading ? t.checking : t.notConfigured}
        disabled={providerOptions.length === 0}
      />

      <LabeledSelect
        label={t.model}
        value={model}
        options={modelOptions}
        onChange={(ref) => setSettings({ model: ref })}
        placeholder={loading ? t.checking : t.notConfigured}
        disabled={modelOptions.length === 0}
      />

      <LabeledSelect
        label={t.reasoning}
        value={reasoning}
        options={reasoningOptions}
        onChange={(next) => setSettings({ reasoning: next as Reasoning })}
      />

      {/* mode 切换：单选 ToggleGroup。整组 aria-label 命名用途；可见文字 = 项标签。 */}
      <div className="flex flex-col gap-1.5">
        <span
          id="runtime-mode-label"
          className="flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground"
        >
          <SlidersHorizontal className="size-3.5" aria-hidden="true" />
          {t.mode}
        </span>
        <ToggleGroup
          // Base UI 默认给组件设 role="group" 并附 aria-orientation；但 group 不允许
          // aria-orientation（axe aria-allowed-attr）。改用 role="toolbar"——既允许
          // aria-orientation，又是「一排切换按钮」的标准模式，修复无障碍违规。
          role="toolbar"
          aria-label={t.mode}
          aria-labelledby="runtime-mode-label"
          // value 为字符串数组（单选 → 单元素）；空选择时回退为空数组。
          value={mode ? [mode] : []}
          onValueChange={(group) => {
            // 仅在确有选择时写回；忽略「取消选中导致空数组」以保证始终有一个 mode。
            const next = group[0] as Mode | undefined;
            if (next) setSettings({ mode: next });
          }}
          variant="outline"
          spacing={0}
          className="w-full"
        >
          <ToggleGroupItem value="act" className="h-11 flex-1">
            {t.act}
          </ToggleGroupItem>
          <ToggleGroupItem value="plan" className="h-11 flex-1">
            {t.plan}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
    </div>
  );
}
