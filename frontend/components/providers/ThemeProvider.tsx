"use client";

// frontend/components/providers/ThemeProvider.tsx
// 主题 Provider：封装 next-themes 的 ThemeProvider。
// next-themes 负责：1) 注入 OS `prefers-color-scheme` 监听器——当偏好为
// "system" 且系统外观在应用打开时切换，UI 会实时更新；2) 通过注入的脚本避免
// 首屏闪烁（no-flash）。这里仅固化项目约定的配置，不做额外逻辑。

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

/**
 * 应用级主题 Provider。
 * 透传 next-themes 的全部 props（便于将来在 layout 之外复用），并预置
 * 项目约定：class 策略、默认跟随系统、启用系统监听、切换时禁用过渡动画，
 * 以及统一的 localStorage 存储键。
 * @param props next-themes ThemeProvider 的 props（含 children），会覆盖默认值。
 */
export function ThemeProvider({
  children,
  ...props
}: ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      storageKey="kodeks.ui.theme"
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}
