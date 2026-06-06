"use client";

// frontend/components/tools/AppearanceControls.tsx
// 外观控件（Task 4.6）：主题切换（light/dark/system）+ 语言切换（zh/en/system）。
// 数据来源：next-themes 的 useTheme（主题）与 useI18n 的 preference/setPreference（语言）。
//
// HIG / 无障碍要点：
//   - 两组均为单选 ToggleGroup，整组通过 aria-label 命名其用途
//     （主题组 = appearance+theme 语义、语言组 = 语言）；当前值由 primitive 的
//     pressed/selected 态传达，不依赖颜色单一信号。
//   - 每个 ToggleGroupItem 高度 ≥ 40px（h-10），可见焦点由 primitive 提供。
//
// Base UI 选型说明：ToggleGroup 的 value 为字符串数组（单选即长度 1），
// onValueChange 回调亦给出数组——取首元素写回各自的状态源。

import { Palette } from "lucide-react";
import { useTheme } from "next-themes";

import { useI18n, type LanguagePreference } from "@/components/providers/I18nProvider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

/**
 * 单组「标签 + 单选 ToggleGroup」分区。
 * 标签经由 id + aria-labelledby 关联到组，组另带 aria-label 双保险，
 * 满足 HIG “整组用途被程序化命名”。value 为字符串数组（单选 → 单元素），
 * onChange 已解包为字符串；忽略「取消选中」造成的空数组以保证始终有一项被选中。
 * @param label    可见标签 + aria-label 文案。
 * @param labelId  关联标签的 DOM id（用于 aria-labelledby）。
 * @param value    当前选中值。
 * @param onChange 选中变化回调（已解包为字符串）。
 * @param options  选项列表（value 写回、label 展示）。
 */
function ToggleRow({
  label,
  labelId,
  value,
  onChange,
  options,
}: {
  label: string;
  labelId: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span
        id={labelId}
        className="px-1 text-xs font-medium text-muted-foreground"
      >
        {label}
      </span>
      <ToggleGroup
        // Base UI 默认 role="group" 会附带 aria-orientation，而 group 不允许该属性
        // （axe aria-allowed-attr）。改用 role="toolbar"：允许 aria-orientation，
        // 且「一排切换按钮」本就是 toolbar 的标准模式。
        role="toolbar"
        aria-label={label}
        aria-labelledby={labelId}
        value={value ? [value] : []}
        onValueChange={(group) => {
          const next = group[0];
          if (next) onChange(next);
        }}
        variant="outline"
        spacing={0}
        className="w-full"
      >
        {options.map((o) => (
          <ToggleGroupItem key={o.value} value={o.value} className="h-10 flex-1">
            {o.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

/**
 * 外观控件面板。
 * 主题切换接 next-themes（theme/setTheme，值 light|dark|system，与 ThemeProvider
 * 的 attribute="class" 配套）；语言切换接 useI18n（preference/setPreference）。
 */
export function AppearanceControls() {
  const { t } = useI18n();
  const { theme, setTheme } = useTheme();
  const { preference, setPreference } = useI18n();

  // 主题三档：值与 next-themes 约定一致（light/dark/system）。
  const themeOptions = [
    { value: "light", label: t.light },
    { value: "dark", label: t.dark },
    { value: "system", label: t.system },
  ];

  // 语言三档：值与 I18nProvider 的 LanguagePreference 一致（zh/en/system）。
  const langOptions = [
    { value: "zh", label: t.zh },
    { value: "en", label: t.en },
    { value: "system", label: t.system },
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* 顶部小标题：图标 + 文字，仅作分区点缀（真正的语义标题在 Shell 的 <h2>）。 */}
      <span className="flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground">
        <Palette className="size-3.5" aria-hidden="true" />
        {t.appearance}
      </span>

      {/* 主题组：aria-label 兼顾外观与主题语义。theme 在挂载前可能为 undefined，回退空串。 */}
      <ToggleRow
        label={`${t.appearance} · ${t.light}/${t.dark}`}
        labelId="appearance-theme-label"
        value={theme ?? ""}
        onChange={(next) => setTheme(next)}
        options={themeOptions}
      />

      {/* 语言组：写回 I18nProvider 的 preference。 */}
      <ToggleRow
        label={`${t.zh}/${t.en}`}
        labelId="appearance-language-label"
        value={preference}
        onChange={(next) => setPreference(next as LanguagePreference)}
        options={langOptions}
      />
    </div>
  );
}
