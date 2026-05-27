"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

import Chat from "@/components/chat";
import { MaterialIcon } from "@/components/material-icon";
import ToolsPanel from "@/components/tools-panel";
import { appendAssistantDelta, updateApprovalState, upsertRuntimeTimelineItem, type TimelineItem } from "@/lib/conversation-timeline";
import type { ChatMode } from "@/lib/chat-stream";
import { sendChatMessage } from "@/lib/kodeks-api";
import {
  defaultUiLanguagePreference,
  defaultUiThemePreference,
  localizeAssistantMessageContent,
  readUiLanguagePreference,
  readUiThemePreference,
  resolveUiLanguage,
  resolveUiTheme,
  type UiLanguage,
  type UiLanguagePreference,
  type UiTheme,
  type UiThemePreference,
  uiCopy,
  writeUiPreference
} from "@/lib/ui-copy";

type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

const languageStorageKey = "kodeks.ui.language";
const themeStorageKey = "kodeks.ui.theme";
type UiPreferenceState = {
  languagePreference: UiLanguagePreference;
  themePreference: UiThemePreference;
  systemLanguage: UiLanguage;
  systemTheme: UiTheme;
  hasLoadedStoredPreferences: boolean;
};

const hydrationSafeUiState: UiPreferenceState = {
  languagePreference: defaultUiLanguagePreference,
  themePreference: defaultUiThemePreference,
  systemLanguage: "zh",
  systemTheme: "light",
  hasLoadedStoredPreferences: false
};

const initialMessage: TimelineItem = {
  type: "message",
  id: "welcome",
  role: "assistant",
  content: uiCopy.zh.app.welcome
};

// 根据浏览器语言推断界面语言；目前只区分中文和英文。
function getSystemLanguage(): UiLanguage {
  if (typeof window === "undefined") {
    return "zh";
  }
  const browserLanguage = window.navigator.languages?.[0] ?? window.navigator.language;
  return browserLanguage.toLowerCase().startsWith("zh") ? "zh" : "en";
}

// 根据系统深浅色偏好推断界面主题。
function getSystemTheme(): UiTheme {
  if (typeof window === "undefined") {
    return "light";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// 只在浏览器挂载后读取持久化偏好，保证 SSR 和客户端首次渲染使用同一份默认值。
function readBrowserUiPreferenceState(): UiPreferenceState {
  if (typeof window === "undefined") {
    return hydrationSafeUiState;
  }
  return {
    languagePreference: readUiLanguagePreference(window.localStorage, languageStorageKey),
    themePreference: readUiThemePreference(window.localStorage, themeStorageKey),
    systemLanguage: getSystemLanguage(),
    systemTheme: getSystemTheme(),
    hasLoadedStoredPreferences: true
  };
}

// 管理 Kodeks 聊天主状态，并把 UI 偏好统一传给左右两侧面板。
export default function Assistant() {
  const [items, setItems] = useState<TimelineItem[]>([initialMessage]);
  const [mode, setMode] = useState<ChatMode>("act");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("medium");
  const [sessionId, setSessionId] = useState("");
  const [uiPreferenceState, setUiPreferenceState] = useState<UiPreferenceState>(() => hydrationSafeUiState);
  const [isAssistantLoading, setAssistantLoading] = useState(false);
  const [isToolsPanelOpen, setIsToolsPanelOpen] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const { languagePreference, themePreference, systemLanguage, systemTheme, hasLoadedStoredPreferences } = uiPreferenceState;
  const language = resolveUiLanguage(languagePreference, systemLanguage);
  const theme = resolveUiTheme(themePreference, systemTheme);
  const copy = uiCopy[language];

  const activityCount = useMemo(() => items.filter((item) => item.type !== "message").length, [items]);

  const visibleItems = useMemo(
    () =>
      items.map((item) => {
        if (item.type === "message" && item.role === "assistant") {
          return { ...item, content: localizeAssistantMessageContent(item.content, copy) };
        }
        return item;
      }),
    [copy, items]
  );

  // 首帧使用稳定默认值，挂载后再恢复浏览器系统值和本地持久化偏好。
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    let isCancelled = false;
    window.queueMicrotask(() => {
      if (isCancelled) {
        return;
      }
      setUiPreferenceState(readBrowserUiPreferenceState());
    });
    return () => {
      isCancelled = true;
    };
  }, []);

  // 主题选择“跟随系统”时，监听系统深浅色变化并即时刷新页面主题。
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    function handleSystemThemeChange(event: MediaQueryListEvent) {
      setUiPreferenceState((currentState) => ({
        ...currentState,
        systemTheme: event.matches ? "dark" : "light"
      }));
    }
    mediaQuery.addEventListener("change", handleSystemThemeChange);
    return () => mediaQuery.removeEventListener("change", handleSystemThemeChange);
  }, []);

  // 用户切换语言或主题后保存偏好，下一次打开页面仍然沿用。
  useEffect(() => {
    if (typeof window === "undefined" || !hasLoadedStoredPreferences) {
      return;
    }
    writeUiPreference(window.localStorage, languageStorageKey, languagePreference);
    writeUiPreference(window.localStorage, themeStorageKey, themePreference);
  }, [hasLoadedStoredPreferences, languagePreference, themePreference]);

  // 切换语言偏好时只更新状态值，避免在渲染期间读取浏览器环境造成 hydration mismatch。
  function handleLanguagePreferenceChange(nextLanguagePreference: UiLanguagePreference) {
    setUiPreferenceState((currentState) => ({
      ...currentState,
      languagePreference: nextLanguagePreference
    }));
  }

  // 切换主题偏好时保留已解析的系统主题，显式选择和 system 模式都能稳定渲染。
  function handleThemePreferenceChange(nextThemePreference: UiThemePreference) {
    setUiPreferenceState((currentState) => ({
      ...currentState,
      themePreference: nextThemePreference
    }));
  }

  // 发送用户消息到本地 Kodeks SSE 接口，并把事件转换成聊天时间线。
  async function handleSendMessage(message: string) {
    const prompt = message.trim();
    if (!prompt || isAssistantLoading) {
      return;
    }

    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setAssistantLoading(true);
    setItems((currentItems) => [
      ...currentItems,
      { type: "message", id: userMessageId, role: "user", content: prompt },
      { type: "message", id: assistantMessageId, role: "assistant", content: "" }
    ]);

    try {
      await sendChatMessage({
        input: prompt,
        sessionId: sessionId || undefined,
        mode,
        reasoningEffort,
        signal: controller.signal,
        onDelta(delta) {
          setItems((currentItems) => appendAssistantDelta(currentItems, assistantMessageId, delta));
        },
        onEvent(event) {
          if (event.type === "session_created") {
            setSessionId(event.sessionId);
          }
          if (event.type === "error") {
            setItems((currentItems) => appendAssistantDelta(currentItems, assistantMessageId, copy.app.runtimeFailed(event.message)));
            return;
          }
          setItems((currentItems) => upsertRuntimeTimelineItem(currentItems, event));
        }
      });
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        setItems((currentItems) =>
          appendAssistantDelta(
            currentItems,
            assistantMessageId,
            copy.app.requestFailed
          )
        );
      }
    } finally {
      setAssistantLoading(false);
      abortControllerRef.current = null;
    }
  }

  // 把审批决定发给本地 approval route，并更新页面上的审批卡片状态。
  async function handleApprovalResponse(decision: "approve" | "reject", id: string) {
    const response = await fetch(`/api/approvals/${id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ decision })
    });

    setItems((currentItems) =>
      updateApprovalState(currentItems, id, response.ok ? (decision === "approve" ? "approved" : "rejected") : "failed")
    );
  }

  // 中止浏览器这一侧的流式请求，但保留当前聊天记录。
  function handleStop() {
    abortControllerRef.current?.abort();
    setAssistantLoading(false);
  }

  // 打开或关闭移动端工具抽屉，复用桌面端同一份设置状态。
  function setMobilePanelOpen(open: boolean) {
    setIsToolsPanelOpen(open);
  }

  return (
    <div
      className={`${theme === "dark" ? "dark" : ""} flex h-full min-h-0 w-full bg-white text-zinc-950 dark:bg-zinc-950 dark:text-zinc-50`}
      data-language={language}
      data-theme={theme}
    >
      <div className="hidden min-h-0 w-[30%] min-w-[320px] max-w-[460px] md:block">
        <ToolsPanel
          activityCount={activityCount}
          copy={copy.tools}
          language={languagePreference}
          mode={mode}
          onLanguageChange={handleLanguagePreferenceChange}
          onModeChange={setMode}
          onReasoningEffortChange={setReasoningEffort}
          onThemeChange={handleThemePreferenceChange}
          reasoningEffort={reasoningEffort}
          sessionId={sessionId}
          theme={themePreference}
        />
      </div>
      <div className="min-h-0 min-w-0 flex-1 bg-white dark:bg-zinc-950 md:w-[70%]">
        <div className="h-full min-h-0 w-full p-4">
          <Chat
            copy={copy}
            isAssistantLoading={isAssistantLoading}
            items={visibleItems}
            onApprovalResponse={handleApprovalResponse}
            onSendMessage={handleSendMessage}
            onStop={handleStop}
          />
        </div>
      </div>
      <div className="absolute right-4 top-4 md:hidden">
        <button
          aria-label={copy.app.mobileToolsOpen}
          className="inline-flex size-10 items-center justify-center rounded-full bg-white text-stone-900 shadow-sm dark:bg-zinc-900 dark:text-zinc-50"
          data-testid="mobile-tools-button"
          onClick={() => setMobilePanelOpen(true)}
          type="button"
        >
          <MaterialIcon name="menu" size={24} />
        </button>
      </div>
      {isToolsPanelOpen ? (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/30 md:hidden">
          <div className="h-full w-full max-w-md bg-white p-4 dark:bg-zinc-950" data-testid="mobile-tools-drawer">
            <button
              aria-label={copy.app.mobileToolsClose}
              className="mb-4 inline-flex size-10 items-center justify-center rounded-full bg-zinc-100 text-stone-900 dark:bg-zinc-900 dark:text-zinc-50"
              onClick={() => setMobilePanelOpen(false)}
              type="button"
            >
              <MaterialIcon name="close" size={24} />
            </button>
            <div className="h-[calc(100%-56px)] min-h-0">
              <ToolsPanel
                activityCount={activityCount}
                copy={copy.tools}
                language={languagePreference}
                mode={mode}
                onLanguageChange={handleLanguagePreferenceChange}
                onModeChange={setMode}
                onReasoningEffortChange={setReasoningEffort}
                onThemeChange={handleThemePreferenceChange}
                reasoningEffort={reasoningEffort}
                sessionId={sessionId}
                theme={themePreference}
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
