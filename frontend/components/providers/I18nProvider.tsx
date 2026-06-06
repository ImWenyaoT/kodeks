"use client";

// frontend/components/providers/I18nProvider.tsx
// 国际化 Provider：用 React Context 暴露当前语言、偏好、切换函数与文案字典。
// SSR / 静态导出安全：localStorage 与 navigator 仅在浏览器侧读取（useEffect /
// typeof window 守卫），首屏统一以默认值渲染，避免 hydration 不一致与构建崩溃。

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { copy, resolveLanguage, type Copy, type Language } from "@/lib/i18n";

/** 语言偏好：具体语言或跟随设备。 */
export type LanguagePreference = Language | "system";

/** localStorage 中存放语言偏好的键。 */
const STORAGE_KEY = "kodeks.ui.language";

/** Context 暴露给消费方的形状。 */
type I18nContextValue = {
  /** 实际生效的界面语言（已解析 system）。 */
  lang: Language;
  /** 用户偏好（可能为 "system"）。 */
  preference: LanguagePreference;
  /** 更新并持久化偏好。 */
  setPreference: (preference: LanguagePreference) => void;
  /** 当前语言对应的文案字典。 */
  t: Copy;
};

const I18nContext = createContext<I18nContextValue | null>(null);

/**
 * 校验任意值是否为合法的语言偏好。
 * 用于过滤 localStorage 中可能被污染/过期的值。
 */
function isPreference(value: unknown): value is LanguagePreference {
  return value === "zh" || value === "en" || value === "system";
}

/**
 * 将偏好解析为实际生效的语言。
 * 偏好为 "system" 时按浏览器语言解析（navigator 在 SSR 缺失时回退到 en）；
 * 否则直接采用偏好语言。
 */
function resolvePreference(preference: LanguagePreference): Language {
  if (preference !== "system") return preference;
  const tag =
    typeof navigator !== "undefined" ? navigator.language : undefined;
  return resolveLanguage(tag ?? "en");
}

/**
 * 国际化 Provider。
 * 首屏（含 SSR / 静态导出）以默认值渲染；挂载后再从 localStorage 读取真实
 * 偏好并据此解析语言，从而既保证构建安全又避免 hydration mismatch。
 * @param children 被包裹的子树。
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  // 初始一律取默认值，保证 server 与首帧 client 渲染一致。
  const [preference, setPreferenceState] =
    useState<LanguagePreference>("system");
  const [lang, setLang] = useState<Language>("en");

  // 同步 <html lang>：layout 以静态 lang="en" 作 SSR 默认，挂载/切换后由此 effect
  // 在客户端校正为实际生效语言，使屏幕阅读器按正确语言朗读（守卫 document 以兼容 SSR）。
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.lang = lang;
  }, [lang]);

  // 仅在浏览器侧（挂载后）读取持久化偏好并解析语言。
  useEffect(() => {
    if (typeof window === "undefined") return;
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      // 隐私模式等场景下 localStorage 可能抛错——忽略，沿用默认值。
    }
    const initial: LanguagePreference = isPreference(stored)
      ? stored
      : "system";
    // 此处的同步 setState 是刻意为之、且无法用惰性初始化替代：首屏（SSR / 静态导出
    // 与首帧 client）必须以默认值渲染才能保证 hydration 一致；localStorage 只能在
    // 挂载后读取，读到后再校正才是正确做法。故对被规则标记的调用针对性禁用。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPreferenceState(initial);
    setLang(resolvePreference(initial));
  }, []);

  /**
   * 更新偏好：写入 state、解析新语言、并持久化到 localStorage。
   */
  const setPreference = useCallback((next: LanguagePreference) => {
    setPreferenceState(next);
    setLang(resolvePreference(next));
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // 写入失败（隐私模式 / 配额）不阻断 UI。
    }
  }, []);

  const value = useMemo<I18nContextValue>(
    () => ({ lang, preference, setPreference, t: copy[lang] }),
    [lang, preference, setPreference],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * 读取国际化 Context 的 hook。
 * 必须在 <I18nProvider> 内部使用，否则抛错以尽早暴露接线错误。
 */
export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (ctx === null) {
    throw new Error("useI18n must be used within an <I18nProvider>");
  }
  return ctx;
}
