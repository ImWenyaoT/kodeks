"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

import Chat from "@/components/chat";
import { MaterialIcon } from "@/components/material-icon";
import ToolsPanel from "@/components/tools-panel";
import WorkspacePanel from "@/components/workspace-panel";
import {
  appendAssistantDelta,
  updateApprovalState,
  upsertRuntimeTimelineItem,
  type TimelineItem,
} from "@/lib/conversation-timeline";
import type { ChatMode } from "@/lib/chat-stream";
import {
  fetchConfiguredModels,
  fetchMoonBridgePreflight,
  sendChatMessage,
  type ConfiguredModelOption,
  type MoonBridgePreflightView,
} from "@/lib/kodeks-api";
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
  writeUiPreference,
} from "@/lib/ui-copy";

type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

type StoredTranscriptMessage = {
  id: string;
  role: string;
  content: unknown;
};

type SessionDetailResponse = {
  messages?: unknown;
};

const languageStorageKey = "kodeks.ui.language";
const themeStorageKey = "kodeks.ui.theme";
type UiPreferenceState = {
  languagePreference: UiLanguagePreference;
  themePreference: UiThemePreference;
  systemLanguage: UiLanguage;
  systemTheme: UiTheme;
  hasLoadedStoredPreferences: boolean;
};

type SidebarPanelMode = "auto" | "expanded" | "collapsed";

const hydrationSafeUiState: UiPreferenceState = {
  languagePreference: defaultUiLanguagePreference,
  themePreference: defaultUiThemePreference,
  systemLanguage: "zh",
  systemTheme: "light",
  hasLoadedStoredPreferences: false,
};

const initialMessage: TimelineItem = {
  type: "message",
  id: "welcome",
  role: "assistant",
  content: uiCopy.zh.app.welcome,
};

// 从本地 transcript content 对象中提取可展示文本，兼容历史 JSON 结构。
function stringifyTranscriptContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (content !== null && typeof content === "object") {
    const text = (content as { text?: unknown }).text;
    if (typeof text === "string") {
      return text;
    }
  }
  return JSON.stringify(content);
}

// 将 session transcript 转成当前聊天时间线可直接渲染的消息项。
function transcriptToTimeline(
  messages: StoredTranscriptMessage[],
): TimelineItem[] {
  const timelineMessages = messages
    .filter(
      (message) =>
        message.role === "user" ||
        message.role === "assistant" ||
        message.role === "system",
    )
    .map((message) => {
      const content = stringifyTranscriptContent(message.content);
      return {
        type: "message" as const,
        id: message.id,
        role: message.role as "user" | "assistant" | "system",
        content,
      };
    })
    .filter((message) => message.content.trim().length > 0);

  return timelineMessages.length > 0 ? timelineMessages : [initialMessage];
}

// 校验 session detail API 的 loose JSON 响应，只保留能恢复的 transcript message。
function readTranscriptMessages(
  body: SessionDetailResponse,
): StoredTranscriptMessage[] {
  if (!Array.isArray(body.messages)) {
    return [];
  }
  return body.messages.filter(
    (message): message is StoredTranscriptMessage =>
      message !== null &&
      typeof message === "object" &&
      typeof (message as { id?: unknown }).id === "string" &&
      typeof (message as { role?: unknown }).role === "string" &&
      "content" in message,
  );
}

// 根据浏览器语言推断界面语言；目前只区分中文和英文。
function getSystemLanguage(): UiLanguage {
  if (typeof window === "undefined") {
    return "zh";
  }
  const browserLanguage =
    window.navigator.languages?.[0] ?? window.navigator.language;
  return browserLanguage.toLowerCase().startsWith("zh") ? "zh" : "en";
}

// 根据系统深浅色偏好推断界面主题。
function getSystemTheme(): UiTheme {
  if (typeof window === "undefined") {
    return "light";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

// 只在浏览器挂载后读取持久化偏好，保证 SSR 和客户端首次渲染使用同一份默认值。
function readBrowserUiPreferenceState(): UiPreferenceState {
  if (typeof window === "undefined") {
    return hydrationSafeUiState;
  }
  return {
    languagePreference: readUiLanguagePreference(
      window.localStorage,
      languageStorageKey,
    ),
    themePreference: readUiThemePreference(
      window.localStorage,
      themeStorageKey,
    ),
    systemLanguage: getSystemLanguage(),
    systemTheme: getSystemTheme(),
    hasLoadedStoredPreferences: true,
  };
}

// 管理 Kodeks 聊天主状态，并把 UI 偏好统一传给左右两侧面板。
export default function Assistant() {
  const [items, setItems] = useState<TimelineItem[]>([initialMessage]);
  const [mode, setMode] = useState<ChatMode>("act");
  const [modelOptions, setModelOptions] = useState<ConfiguredModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [bridgePreflight, setBridgePreflight] =
    useState<MoonBridgePreflightView>({
      status: "checking",
      provider: "auto",
    });
  const [reasoningEffort, setReasoningEffort] =
    useState<ReasoningEffort>("medium");
  const [sessionId, setSessionId] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [uiPreferenceState, setUiPreferenceState] = useState<UiPreferenceState>(
    () => hydrationSafeUiState,
  );
  const [isAssistantLoading, setAssistantLoading] = useState(false);
  const [isToolsPanelOpen, setIsToolsPanelOpen] = useState(false);
  const [toolsPanelMode, setToolsPanelMode] =
    useState<SidebarPanelMode>("auto");
  const [workspacePanelMode, setWorkspacePanelMode] =
    useState<SidebarPanelMode>("auto");
  const abortControllerRef = useRef<AbortController | null>(null);
  const {
    languagePreference,
    themePreference,
    systemLanguage,
    systemTheme,
    hasLoadedStoredPreferences,
  } = uiPreferenceState;
  const language = resolveUiLanguage(languagePreference, systemLanguage);
  const theme = resolveUiTheme(themePreference, systemTheme);
  const copy = uiCopy[language];

  const activityCount = useMemo(
    () => items.filter((item) => item.type !== "message").length,
    [items],
  );

  const visibleItems = useMemo(
    () =>
      items.map((item) => {
        if (item.type === "message" && item.role === "assistant") {
          return {
            ...item,
            content: localizeAssistantMessageContent(item.content, copy),
          };
        }
        return item;
      }),
    [copy, items],
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
        systemTheme: event.matches ? "dark" : "light",
      }));
    }
    mediaQuery.addEventListener("change", handleSystemThemeChange);
    return () =>
      mediaQuery.removeEventListener("change", handleSystemThemeChange);
  }, []);

  // 用户切换语言或主题后保存偏好，下一次打开页面仍然沿用。
  useEffect(() => {
    if (typeof window === "undefined" || !hasLoadedStoredPreferences) {
      return;
    }
    writeUiPreference(
      window.localStorage,
      languageStorageKey,
      languagePreference,
    );
    writeUiPreference(window.localStorage, themeStorageKey, themePreference);
  }, [hasLoadedStoredPreferences, languagePreference, themePreference]);

  // 页面打开时读取用户配置中的 provider/model 清单，并选中 primary model。
  useEffect(() => {
    const controller = new AbortController();
    fetchConfiguredModels(controller.signal)
      .then((catalog) => {
        setModelOptions(catalog.models);
        const selected =
          catalog.models.find((model) => model.ref === catalog.primary) ??
          catalog.models[0];
        if (selected !== undefined) {
          setSelectedModel(selected.ref);
        }
      })
      .catch(() => {
        setModelOptions([]);
      });
    return () => controller.abort();
  }, []);

  // 页面打开或模型切换时预检 MoonBridge，让右侧调试面板显示真实 runtime 状态。
  useEffect(() => {
    const controller = new AbortController();
    fetchMoonBridgePreflight(selectedModel || undefined, controller.signal)
      .then((result) => setBridgePreflight(result))
      .catch((error) => {
        if ((error as Error).name === "AbortError") {
          return;
        }
        setBridgePreflight({
          status: "unavailable",
          provider: "auto",
          reason: error instanceof Error ? error.message : String(error),
          checkedAt: new Date().toISOString(),
        });
      });

    return () => controller.abort();
  }, [selectedModel]);

  // 切换语言偏好时只更新状态值，避免在渲染期间读取浏览器环境造成 hydration mismatch。
  function handleLanguagePreferenceChange(
    nextLanguagePreference: UiLanguagePreference,
  ) {
    setUiPreferenceState((currentState) => ({
      ...currentState,
      languagePreference: nextLanguagePreference,
    }));
  }

  // 切换主题偏好时保留已解析的系统主题，显式选择和 system 模式都能稳定渲染。
  function handleThemePreferenceChange(nextThemePreference: UiThemePreference) {
    setUiPreferenceState((currentState) => ({
      ...currentState,
      themePreference: nextThemePreference,
    }));
  }

  // 切换模型时立即把预检状态归零，随后由 effect 读取真实后端状态。
  function handleModelChange(nextModel: string) {
    setSelectedModel(nextModel);
    setBridgePreflight({ status: "checking", provider: "auto" });
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
      {
        type: "message",
        id: assistantMessageId,
        role: "assistant",
        content: "",
      },
    ]);

    try {
      await sendChatMessage({
        input: prompt,
        sessionId: sessionId || undefined,
        mode,
        model: selectedModel,
        reasoningEffort,
        selectedFiles,
        signal: controller.signal,
        onDelta(delta) {
          setItems((currentItems) =>
            appendAssistantDelta(currentItems, assistantMessageId, delta),
          );
        },
        onEvent(event) {
          if (event.type === "session_created") {
            setSessionId(event.sessionId);
          }
          if (event.type === "error") {
            setItems((currentItems) =>
              upsertRuntimeTimelineItem(
                appendAssistantDelta(
                  currentItems,
                  assistantMessageId,
                  copy.app.runtimeFailed(event.message),
                ),
                event,
              ),
            );
            return;
          }
          setItems((currentItems) =>
            upsertRuntimeTimelineItem(currentItems, event),
          );
        },
      });
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        setItems((currentItems) =>
          appendAssistantDelta(
            currentItems,
            assistantMessageId,
            copy.app.requestFailed,
          ),
        );
      }
    } finally {
      setAssistantLoading(false);
      abortControllerRef.current = null;
    }
  }

  // 把审批决定发给本地 approval route，并更新页面上的审批卡片状态。
  async function handleApprovalResponse(
    decision: "approve" | "reject",
    id: string,
  ) {
    const response = await fetch(`/api/approvals/${id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ decision }),
    });

    setItems((currentItems) =>
      updateApprovalState(
        currentItems,
        id,
        response.ok
          ? decision === "approve"
            ? "approved"
            : "rejected"
          : "failed",
      ),
    );
  }

  // 中止浏览器这一侧的流式请求，但保留当前聊天记录。
  function handleStop() {
    abortControllerRef.current?.abort();
    setAssistantLoading(false);
  }

  // 新建一个空白本地会话，下一次发送时再由 runtime 分配 durable session。
  function handleNewSession() {
    abortControllerRef.current?.abort();
    setAssistantLoading(false);
    setSessionId("");
    setItems([initialMessage]);
  }

  // 展开桌面左侧 workspace 面板，用于 NotebookLM-style rail 的展开按钮。
  function expandWorkspacePanel() {
    setWorkspacePanelMode("expanded");
  }

  // 折叠桌面左侧 workspace 面板，用于完整面板的收起按钮。
  function collapseWorkspacePanel() {
    setWorkspacePanelMode("collapsed");
  }

  // 展开桌面右侧工具面板，用于 NotebookLM-style rail 的展开按钮。
  function expandToolsPanel() {
    setToolsPanelMode("expanded");
  }

  // 折叠桌面右侧工具面板，用于完整调试面板的收起按钮。
  function collapseToolsPanel() {
    setToolsPanelMode("collapsed");
  }

  // 手动刷新 MoonBridge 预检，方便用户修好本地服务后不重载页面。
  async function refreshBridgePreflight() {
    const controller = new AbortController();
    setBridgePreflight({ status: "checking", provider: "auto" });
    try {
      setBridgePreflight(
        await fetchMoonBridgePreflight(
          selectedModel || undefined,
          controller.signal,
        ),
      );
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        return;
      }
      setBridgePreflight({
        status: "unavailable",
        provider: "auto",
        reason: error instanceof Error ? error.message : String(error),
        checkedAt: new Date().toISOString(),
      });
    }
  }

  // 从左侧历史中选择一个 session，并恢复它已持久化的 transcript。
  async function handleSessionSelect(nextSessionId: string) {
    if (!nextSessionId || nextSessionId === sessionId) {
      return;
    }
    abortControllerRef.current?.abort();
    setAssistantLoading(false);
    setSessionId(nextSessionId);
    try {
      const response = await fetch(`/api/sessions/${nextSessionId}`);
      if (!response.ok) {
        throw new Error(`Session request failed with ${response.status}`);
      }
      const body = (await response.json()) as SessionDetailResponse;
      setItems(transcriptToTimeline(readTranscriptMessages(body)));
    } catch (error) {
      setItems([
        initialMessage,
        {
          type: "error",
          id: `session-load-${nextSessionId}`,
          message:
            error instanceof Error ? error.message : copy.app.requestFailed,
        },
      ]);
    }
  }

  // 打开或关闭移动端工具抽屉，复用桌面端同一份设置状态。
  function setMobilePanelOpen(open: boolean) {
    setIsToolsPanelOpen(open);
  }

  const shellThemeClass =
    theme === "dark"
      ? "dark bg-[#1b1d21] text-slate-100"
      : "bg-[#eef2ff] text-slate-950";
  const workspacePanelWidthClass =
    workspacePanelMode === "expanded"
      ? "w-[260px]"
      : workspacePanelMode === "collapsed"
        ? "w-[64px]"
        : "w-[64px] 2xl:w-[260px]";
  const toolsPanelWidthClass =
    toolsPanelMode === "expanded"
      ? "w-[340px]"
      : toolsPanelMode === "collapsed"
        ? "w-[64px]"
        : "w-[64px] 2xl:w-[340px]";

  return (
    <div
      className={`${shellThemeClass} flex h-full min-h-0 w-full md:gap-2.5 md:p-2`}
      data-language={language}
      data-theme={theme}
    >
      <div
        className={`hidden min-h-0 shrink-0 overflow-hidden rounded-[16px] transition-[width] duration-200 md:block ${workspacePanelWidthClass}`}
      >
        <div
          className={`h-full ${
            workspacePanelMode === "expanded"
              ? "hidden"
              : workspacePanelMode === "auto"
                ? "2xl:hidden"
                : ""
          }`}
        >
          <WorkspacePanel
            collapsed
            copy={copy.tools}
            currentSessionId={sessionId}
            onCollapseToggle={expandWorkspacePanel}
            onNewSession={handleNewSession}
            onSelectedFilesChange={setSelectedFiles}
            onSessionSelect={handleSessionSelect}
            selectedFiles={selectedFiles}
          />
        </div>
        {workspacePanelMode !== "collapsed" ? (
          <div
            className={`h-full ${
              workspacePanelMode === "auto" ? "hidden 2xl:block" : ""
            }`}
          >
            <WorkspacePanel
              collapsed={false}
              copy={copy.tools}
              currentSessionId={sessionId}
              onCollapseToggle={collapseWorkspacePanel}
              onNewSession={handleNewSession}
              onSelectedFilesChange={setSelectedFiles}
              onSessionSelect={handleSessionSelect}
              selectedFiles={selectedFiles}
            />
          </div>
        ) : null}
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden bg-white text-slate-950 shadow-sm md:rounded-[16px] md:border md:border-slate-200 dark:bg-[#202428] dark:text-slate-100 dark:border-[#343a40] dark:shadow-none">
        <div className="h-full min-h-0 w-full p-4">
          <Chat
            copy={copy}
            isAssistantLoading={isAssistantLoading}
            items={visibleItems}
            onApprovalResponse={handleApprovalResponse}
            onSendMessage={handleSendMessage}
            onStop={handleStop}
            selectedFiles={selectedFiles}
          />
        </div>
      </div>
      <div
        className={`hidden min-h-0 shrink-0 overflow-hidden rounded-[16px] transition-[width] duration-200 md:block ${toolsPanelWidthClass}`}
      >
        <div
          className={`h-full ${
            toolsPanelMode === "expanded"
              ? "hidden"
              : toolsPanelMode === "auto"
                ? "2xl:hidden"
                : ""
          }`}
        >
          <ToolsPanel
            activityCount={activityCount}
            bridgePreflight={bridgePreflight}
            collapsed
            copy={copy.tools}
            language={languagePreference}
            mode={mode}
            onBridgePreflightRefresh={refreshBridgePreflight}
            onCollapseToggle={expandToolsPanel}
            onLanguageChange={handleLanguagePreferenceChange}
            onModeChange={setMode}
            onModelChange={handleModelChange}
            onReasoningEffortChange={setReasoningEffort}
            onThemeChange={handleThemePreferenceChange}
            modelOptions={modelOptions}
            reasoningEffort={reasoningEffort}
            selectedModel={selectedModel}
            sessionId={sessionId}
            theme={themePreference}
          />
        </div>
        {toolsPanelMode !== "collapsed" ? (
          <div
            className={`h-full ${
              toolsPanelMode === "auto" ? "hidden 2xl:block" : ""
            }`}
          >
            <ToolsPanel
              activityCount={activityCount}
              bridgePreflight={bridgePreflight}
              collapsed={false}
              copy={copy.tools}
              language={languagePreference}
              mode={mode}
              onBridgePreflightRefresh={refreshBridgePreflight}
              onCollapseToggle={collapseToolsPanel}
              onLanguageChange={handleLanguagePreferenceChange}
              onModeChange={setMode}
              onModelChange={handleModelChange}
              onReasoningEffortChange={setReasoningEffort}
              onThemeChange={handleThemePreferenceChange}
              modelOptions={modelOptions}
              reasoningEffort={reasoningEffort}
              selectedModel={selectedModel}
              sessionId={sessionId}
              theme={themePreference}
            />
          </div>
        ) : null}
      </div>
      <div className="absolute right-4 top-4 md:hidden">
        <button
          aria-label={copy.app.mobileToolsOpen}
          className="inline-flex size-10 items-center justify-center rounded-full bg-white text-slate-900 shadow-sm dark:bg-[#111827] dark:text-slate-100"
          data-testid="mobile-tools-button"
          onClick={() => setMobilePanelOpen(true)}
          type="button"
        >
          <MaterialIcon name="menu" size={24} />
        </button>
      </div>
      {isToolsPanelOpen ? (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/30 md:hidden">
          <div
            className="h-full w-full max-w-md bg-[#eef2ff] p-4 dark:bg-[#1b1d21]"
            data-testid="mobile-tools-drawer"
          >
            <button
              aria-label={copy.app.mobileToolsClose}
              className="mb-4 inline-flex size-10 items-center justify-center rounded-full bg-white text-slate-900 shadow-sm dark:bg-[#111827] dark:text-slate-100"
              onClick={() => setMobilePanelOpen(false)}
              type="button"
            >
              <MaterialIcon name="close" size={24} />
            </button>
            <div className="h-[calc(100%-56px)] min-h-0">
              <ToolsPanel
                activityCount={activityCount}
                bridgePreflight={bridgePreflight}
                collapsed={false}
                copy={copy.tools}
                language={languagePreference}
                mode={mode}
                onBridgePreflightRefresh={refreshBridgePreflight}
                onLanguageChange={handleLanguagePreferenceChange}
                onModeChange={setMode}
                onModelChange={handleModelChange}
                onReasoningEffortChange={setReasoningEffort}
                onThemeChange={handleThemePreferenceChange}
                modelOptions={modelOptions}
                reasoningEffort={reasoningEffort}
                selectedModel={selectedModel}
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
