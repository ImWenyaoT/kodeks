"use client";

import { type FormEvent, type KeyboardEvent, type MouseEvent, useEffect, useMemo, useRef, useState } from "react";

import { type ChatMode, type ChatStreamEvent } from "@/lib/chat-stream";
import { sendChatMessage } from "@/lib/kodeks-api";

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
};

type PendingApproval = {
  id: string;
  reason: string;
};

type ActivityKind = "approval" | "memory" | "session" | "status" | "subagent" | "tool";

type ActivityItem = {
  id: string;
  kind: ActivityKind;
  title: string;
  detail: string;
  state?: "active" | "done" | "ready" | "waiting";
};

type UiLanguage = "zh" | "en";
type ColorTheme = "system" | "light" | "dark";
type ActiveView = "activity" | "chat";
type UiCopy = (typeof uiCopy)[UiLanguage];

const reasoningOptions = [
  { labels: { zh: "低", en: "Low" }, value: "low" },
  { labels: { zh: "中", en: "Medium" }, value: "medium" },
  { labels: { zh: "高", en: "High" }, value: "high" },
  { labels: { zh: "超高", en: "X-high" }, value: "xhigh" }
] as const;

type ReasoningOption = (typeof reasoningOptions)[number];
type ReasoningEffort = ReasoningOption["value"];

const uiCopy = {
  zh: {
    assistantRole: "Kodeks",
    approval: "审批",
    approvalFailed: "审批请求失败，HTTP ",
    approvalRequired: "需要确认",
    activityTitle: "Agent 活动",
    activitySubtitle: "能力与运行轨迹",
    activityNav: "活动",
    artifacts: "Artifacts",
    appearance: "外观",
    approve: "批准",
    autoSession: "auto session",
    chatMode: "对话模式",
    chinese: "中文",
    collapseSidebar: "收起侧栏",
    english: "English",
    expandSidebar: "展开侧栏",
    language: "界面语言",
    localAgent: "本地代理",
    messageLabel: "消息",
    modelMenuTitle: "智能",
    navLabel: "主导航",
    newChat: "新对话",
    placeholder: "给 Kodeks 发送消息",
    reasoning: "智能",
    reject: "拒绝",
    requestFailed: "请求失败了。确认本地 Next.js runtime 还在 http://127.0.0.1:3000 运行。",
    runFailedPrefix: "运行失败：",
    send: "发送",
    sendLabel: "发送消息",
    session: "会话",
    sessionPlaceholder: "留空自动创建",
    settings: "打开设置",
    settingsDialog: "对话设置",
    stopStreaming: "停止生成",
    syncWithSystem: "跟随系统",
    title: "Kodeks agent",
    today: "今天",
    userRole: "你",
    welcome: "你好，我是 Kodeks。把要处理的代码上下文发给我。",
    activity: {
      approvalRequired: "等待人工确认",
      completed: "响应完成",
      memoryRecalled: "召回记忆",
      sessionCreated: "会话已创建",
      status: "状态更新",
      subagentCompleted: "子代理完成",
      subagentStarted: "子代理启动",
      toolCall: "调用工具",
      toolResult: "工具结果"
    },
    capabilities: {
      approval: "审批",
      approvalDetail: "危险 shell 命令会暂停并等待确认",
      memory: "记忆",
      memoryDetail: "按输入召回 project/session memory",
      session: "会话",
      sessionDetail: "保留 session id 与可恢复 transcript",
      subagent: "子代理",
      subagentDetail: "独立探索任务并回传摘要",
      tools: "工作区工具",
      toolsDetail: "读写文件、grep、受控运行 shell"
    },
    status: {
      act: "Act mode",
      plan: "Plan mode",
      streaming: "Streaming"
    },
    theme: {
      dark: "Dark",
      light: "Light",
      system: "System"
    }
  },
  en: {
    assistantRole: "Kodeks",
    approval: "Approval",
    approvalFailed: "Approval request failed with HTTP ",
    approvalRequired: "Approval required",
    activityTitle: "Agent Activity",
    activitySubtitle: "Capabilities and run trace",
    activityNav: "Activity",
    artifacts: "Artifacts",
    appearance: "Appearance",
    approve: "Approve",
    autoSession: "auto session",
    chatMode: "Chat mode",
    chinese: "中文",
    collapseSidebar: "Collapse sidebar",
    english: "English",
    expandSidebar: "Expand sidebar",
    language: "UI language",
    localAgent: "Local agent",
    messageLabel: "Message",
    modelMenuTitle: "Reasoning",
    navLabel: "Main navigation",
    newChat: "New chat",
    placeholder: "Message Kodeks",
    reasoning: "Reasoning",
    reject: "Reject",
    requestFailed: "Request failed. Confirm the local Next.js runtime is still running at http://127.0.0.1:3000.",
    runFailedPrefix: "Runtime failed: ",
    send: "Send",
    sendLabel: "Send message",
    session: "Session",
    sessionPlaceholder: "Leave blank to create one",
    settings: "Open settings",
    settingsDialog: "Chat settings",
    stopStreaming: "Stop streaming",
    syncWithSystem: "Sync with system",
    title: "Kodeks agent",
    today: "Today",
    userRole: "You",
    welcome: "Hi, I am Kodeks. Send me the code context you want handled.",
    activity: {
      approvalRequired: "Waiting for approval",
      completed: "Response completed",
      memoryRecalled: "Memory recalled",
      sessionCreated: "Session created",
      status: "Status update",
      subagentCompleted: "Subagent completed",
      subagentStarted: "Subagent started",
      toolCall: "Tool call",
      toolResult: "Tool result"
    },
    capabilities: {
      approval: "Approval",
      approvalDetail: "Dangerous shell commands pause for review",
      memory: "Memory",
      memoryDetail: "Recalls project and session memory",
      session: "Session",
      sessionDetail: "Keeps session id and resumable transcript",
      subagent: "Subagent",
      subagentDetail: "Runs isolated exploration tasks",
      tools: "Workspace tools",
      toolsDetail: "Read, write, grep, and controlled shell"
    },
    status: {
      act: "Act mode",
      plan: "Plan mode",
      streaming: "Streaming"
    },
    theme: {
      dark: "Dark",
      light: "Light",
      system: "System"
    }
  }
} as const;

type ComposerKeyLike = {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  isComposing: boolean;
};

// Renders one Google Material Symbols glyph with consistent sizing for controls.
function MaterialIcon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <span aria-hidden="true" className="material-symbols-rounded material-icon" style={{ fontSize: `${size}px` }}>
      {name}
    </span>
  );
}

// Decides whether one composer key press should submit instead of inserting text.
export function shouldSubmitComposerKey(event: ComposerKeyLike): boolean {
  return (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.isComposing
  );
}

// Converts event payloads into a one-line activity summary for the inspector.
function summarizeActivityPayload(payload: unknown): string {
  if (payload === null || payload === undefined) {
    return "";
  }

  if (typeof payload === "string") {
    return payload;
  }

  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

// Renders one chat transcript row with compact Vercel-style message chrome.
function MessageArticle({ copy, message }: { copy: UiCopy; message: ChatMessage }) {
  return (
    <article className={`message ${message.role}`}>
      <div className="avatar" aria-hidden="true">
        {message.role === "user" ? (
          <MaterialIcon name="person" size={16} />
        ) : (
          <MaterialIcon name="smart_toy" size={16} />
        )}
      </div>
      <div className="bubble">
        <span className="role-label">
          {message.role === "user" ? copy.userRole : copy.assistantRole}
        </span>
        <p>{message.id === "welcome" ? copy.welcome : message.content || "..."}</p>
      </div>
    </article>
  );
}

// Renders reusable agent activity rows for both the docked inspector and the full page view.
function ActivityPanel({
  className = "",
  copy,
  items
}: {
  className?: string;
  copy: UiCopy;
  items: ActivityItem[];
}) {
  return (
    <aside className={className ? `activity-panel ${className}` : "activity-panel"} aria-label={copy.activityTitle}>
      <div className="activity-heading">
        <div>
          <strong>{copy.activityTitle}</strong>
          <span>{copy.activitySubtitle}</span>
        </div>
        <span className="activity-count">{items.length}</span>
      </div>
      <div className="activity-list">
        {items.map((item) => (
          <article className={`activity-row ${item.kind}`} key={item.id}>
            <span className={item.state ? `activity-dot ${item.state}` : "activity-dot"} aria-hidden="true" />
            <div>
              <strong>{item.title}</strong>
              <p>{item.detail}</p>
            </div>
          </article>
        ))}
      </div>
    </aside>
  );
}

// Renders the minimal interactive chat surface for the kodeks backend.
export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content: uiCopy.zh.welcome
    }
  ]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<ChatMode>("act");
  const [activeView, setActiveView] = useState<ActiveView>("chat");
  const [uiLanguage, setUiLanguage] = useState<UiLanguage>("zh");
  const [colorTheme, setColorTheme] = useState<ColorTheme>("system");
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState<ReasoningEffort>("medium");
  const [activityItems, setActivityItems] = useState<ActivityItem[]>([]);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [sessionId, setSessionId] = useState("s_demo");
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const messageTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);

  const copy = uiCopy[uiLanguage];
  const canSend = input.trim().length > 0 && !isStreaming;
  const statusText = useMemo(() => {
    if (isStreaming) {
      return copy.status.streaming;
    }
    return mode === "plan" ? copy.status.plan : copy.status.act;
  }, [copy.status.act, copy.status.plan, copy.status.streaming, isStreaming, mode]);
  const selectedReasoningLabel = useMemo(
    () =>
      reasoningOptions.find((option) => option.value === selectedReasoningEffort)?.labels[uiLanguage] ??
      reasoningOptions[1].labels[uiLanguage],
    [selectedReasoningEffort, uiLanguage]
  );
  const visibleActivityItems = useMemo<ActivityItem[]>(
    () => [
      {
        id: "capability-tools",
        kind: "tool",
        title: copy.capabilities.tools,
        detail: copy.capabilities.toolsDetail,
        state: "ready"
      },
      {
        id: "capability-memory",
        kind: "memory",
        title: copy.capabilities.memory,
        detail: copy.capabilities.memoryDetail,
        state: "ready"
      },
      {
        id: "capability-subagent",
        kind: "subagent",
        title: copy.capabilities.subagent,
        detail: copy.capabilities.subagentDetail,
        state: "ready"
      },
      {
        id: "capability-approval",
        kind: "approval",
        title: copy.capabilities.approval,
        detail: copy.capabilities.approvalDetail,
        state: "ready"
      },
      {
        id: "capability-session",
        kind: "session",
        title: copy.capabilities.session,
        detail: copy.capabilities.sessionDetail,
        state: "ready"
      },
      ...activityItems
    ],
    [activityItems, copy.capabilities]
  );

  useEffect(() => {
    if (colorTheme === "system") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.dataset.theme = colorTheme;
    }
    document.documentElement.lang = uiLanguage === "zh" ? "zh-CN" : "en";
  }, [colorTheme, uiLanguage]);

  useEffect(() => {
    const messageList = messageListRef.current;
    if (messageList === null) {
      return;
    }

    messageList.scrollTo({ top: messageList.scrollHeight, behavior: "smooth" });
  }, [messages, isStreaming]);

  // Submits one message and appends streamed text into the active assistant bubble.
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const prompt = input.trim();
    if (prompt.length === 0 || isStreaming) {
      return;
    }

    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setInput("");
    setIsStreaming(true);
    setMessages((currentMessages) => [
      ...currentMessages,
      { id: userMessageId, role: "user", content: prompt },
      { id: assistantMessageId, role: "assistant", content: "" }
    ]);

    try {
      await sendChatMessage({
        input: prompt,
        sessionId: sessionId.trim() || undefined,
        mode,
        reasoningEffort: selectedReasoningEffort,
        signal: controller.signal,
        onDelta(delta) {
          setMessages((currentMessages) =>
            currentMessages.map((message) =>
              message.id === assistantMessageId
                ? { ...message, content: `${message.content}${delta}` }
                : message
            )
          );
        },
        onEvent(streamEvent) {
          if (streamEvent.type === "error") {
            showAssistantError(assistantMessageId, streamEvent.message);
          }
          recordStreamEvent(streamEvent);
        }
      });
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        setMessages((currentMessages) =>
          currentMessages.map((message) =>
            message.id === assistantMessageId
              ? {
                  ...message,
                  content:
                    message.content ||
                    copy.requestFailed
                }
              : message
          )
        );
      }
    } finally {
      setIsStreaming(false);
      abortControllerRef.current = null;
    }
  }

  // Submits the composer from the keyboard while preserving Shift+Enter multiline input.
  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      !shouldSubmitComposerKey({
        key: event.key,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        isComposing: event.nativeEvent.isComposing
      })
    ) {
      return;
    }

    event.preventDefault();
    if (canSend) {
      event.currentTarget.form?.requestSubmit();
    }
  }

  // Moves sidebar navigation to the chat target and focuses the composer.
  function handleChatNavigation(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    setActiveView("chat");
    window.history.replaceState(null, "", "#chat");
    document.getElementById("chat")?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => messageTextareaRef.current?.focus(), 180);
  }

  // Opens the secondary activity view where runtime capabilities and events live.
  function handleActivityNavigation() {
    setActiveView("activity");
    window.history.replaceState(null, "", "#activity");
  }

  // Writes stream errors into the active assistant bubble instead of hiding them in telemetry.
  function showAssistantError(assistantMessageId: string, message: string) {
    setMessages((currentMessages) =>
      currentMessages.map((currentMessage) =>
        currentMessage.id === assistantMessageId
          ? { ...currentMessage, content: `${copy.runFailedPrefix}${message}` }
          : currentMessage
      )
    );
  }

  // Cancels the current browser-side request without clearing the conversation.
  function handleStop() {
    abortControllerRef.current?.abort();
    setIsStreaming(false);
  }

  // Adds compact stream telemetry so tool calls and completion are visible.
  function recordStreamEvent(streamEvent: ChatStreamEvent) {
    if (streamEvent.type === "session_created") {
      setSessionId(streamEvent.sessionId);
      appendActivity({
        kind: "session",
        title: copy.activity.sessionCreated,
        detail: streamEvent.sessionId || copy.autoSession,
        state: "done"
      });
      return;
    }

    if (streamEvent.type === "assistant_status") {
      appendActivity({
        kind: "status",
        title: copy.activity.status,
        detail: streamEvent.message,
        state: "active"
      });
      return;
    }

    if (streamEvent.type === "tool_call") {
      appendActivity({
        kind: "tool",
        title: `${copy.activity.toolCall}${streamEvent.toolName ? ` · ${streamEvent.toolName}` : ""}`,
        detail: summarizeActivityPayload(streamEvent.toolArguments),
        state: "active"
      });
      return;
    }

    if (streamEvent.type === "tool_result") {
      appendActivity({
        kind: "tool",
        title: `${copy.activity.toolResult}${streamEvent.toolName ? ` · ${streamEvent.toolName}` : ""}`,
        detail: summarizeActivityPayload(streamEvent.toolOutput) || streamEvent.toolStatus || "",
        state: streamEvent.toolStatus === "approval_required" ? "waiting" : "done"
      });
      return;
    }

    if (streamEvent.type === "response_completed") {
      appendActivity({
        kind: "session",
        title: copy.activity.completed,
        detail: streamEvent.responseId,
        state: "done"
      });
      return;
    }

    if (streamEvent.type === "approval_required") {
      setPendingApproval({
        id: streamEvent.approvalId,
        reason: streamEvent.message
      });
      appendActivity({
        kind: "approval",
        title: copy.activity.approvalRequired,
        detail: streamEvent.message,
        state: "waiting"
      });
      return;
    }

    if (streamEvent.type === "memory_recalled") {
      appendActivity({
        kind: "memory",
        title: copy.activity.memoryRecalled,
        detail: streamEvent.memoryIds.length > 0 ? streamEvent.memoryIds.join(", ") : "0",
        state: "done"
      });
      return;
    }

    if (streamEvent.type === "subagent_started") {
      appendActivity({
        kind: "subagent",
        title: `${copy.activity.subagentStarted} · ${streamEvent.agent}`,
        detail: streamEvent.runId,
        state: "active"
      });
      return;
    }

    if (streamEvent.type === "subagent_completed") {
      appendActivity({
        kind: "subagent",
        title: copy.activity.subagentCompleted,
        detail: streamEvent.summary,
        state: "done"
      });
      return;
    }
  }

  // Appends one visible runtime activity row while keeping the panel compact.
  function appendActivity(item: Omit<ActivityItem, "id">) {
    setActivityItems((currentItems) => [
      ...currentItems.slice(-7),
      {
        ...item,
        id: crypto.randomUUID()
      }
    ]);
  }

  // Sends an approval decision to the local TS approval API.
  async function decideApproval(decision: "approve" | "reject") {
    if (pendingApproval === null) {
      return;
    }

    const approvalId = pendingApproval.id;
    const response = await fetch(`/api/approvals/${approvalId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ decision })
    });

    if (response.ok) {
      setPendingApproval(null);
      return;
    }

    setPendingApproval({
      id: approvalId,
      reason: `${copy.approvalFailed}${response.status}.`
    });
  }

  return (
    <main className={isSidebarOpen ? "app-shell sidebar-open" : "app-shell sidebar-collapsed"}>
      <aside className="store-sidebar" aria-label="Kodeks navigation">
        <div className="sidebar-brand">
          <button
            aria-expanded={isSidebarOpen}
            aria-label={isSidebarOpen ? copy.collapseSidebar : copy.expandSidebar}
            className="appstore-mark sidebar-toggle"
            onClick={() => setIsSidebarOpen((current) => !current)}
            type="button"
          >
            <MaterialIcon name="code_blocks" size={20} />
          </button>
          <div className="sidebar-brand-text">
            <strong>Kodeks</strong>
            <span>{copy.localAgent}</span>
          </div>
        </div>

        <nav className="sidebar-nav" aria-label={copy.navLabel}>
          <button className="new-chat-button" onClick={handleChatNavigation} type="button">
            <MaterialIcon name="add" size={18} />
            <span>{copy.newChat}</span>
          </button>
          <button className={activeView === "chat" ? "active" : ""} onClick={handleChatNavigation} type="button">
            <MaterialIcon name="chat_bubble" size={18} />
            <span>Chat</span>
          </button>
          <button className={activeView === "activity" ? "active" : ""} onClick={handleActivityNavigation} type="button">
            <MaterialIcon name="monitoring" size={18} />
            <span>{copy.activityNav}</span>
          </button>
        </nav>

        <div className="sidebar-spacer" />

        <div className="session-stack" aria-label={copy.session}>
          <span className="sidebar-section-label">{copy.session}</span>
          <span className="sidebar-section-label subtle">{copy.today}</span>
          <button className="session-card active" onClick={handleChatNavigation} type="button">
            <span className="session-card-title">{sessionId.trim() || copy.autoSession}</span>
            <span>{mode === "plan" ? copy.status.plan : copy.status.act}</span>
          </button>
        </div>
      </aside>

      <section className="store-main" aria-label="Kodeks chat">
        <header className="workbench-header">
          <div className="chat-title-stack">
            <span>Kodeks Chat</span>
            <h1>{activeView === "activity" ? copy.activityTitle : copy.title}</h1>
          </div>
          <div className="header-meta">
            <span>{sessionId.trim() || copy.autoSession}</span>
            <span>{selectedReasoningLabel} {copy.reasoning.toLowerCase()}</span>
            <div className="status" aria-live="polite">
              <span className={isStreaming ? "status-dot active" : "status-dot"} />
              {statusText}
            </div>
            <div className={isSettingsOpen ? "settings-dock open" : "settings-dock"}>
              <button
                aria-expanded={isSettingsOpen}
                aria-haspopup="dialog"
                aria-label={copy.settings}
                className="icon-button settings-trigger"
                onClick={() => setIsSettingsOpen((current) => !current)}
                type="button"
              >
                <MaterialIcon name="settings" size={17} />
              </button>
              {isSettingsOpen ? (
                <div className="settings-panel" role="dialog" aria-label={copy.settingsDialog}>
                  <div className="settings-field">
                    <span>{copy.language}</span>
                    <div className="settings-segment" aria-label={copy.language}>
                      <button
                        className={uiLanguage === "zh" ? "selected" : ""}
                        onClick={() => setUiLanguage("zh")}
                        type="button"
                      >
                        {copy.chinese}
                      </button>
                      <button
                        className={uiLanguage === "en" ? "selected" : ""}
                        onClick={() => setUiLanguage("en")}
                        type="button"
                      >
                        {copy.english}
                      </button>
                    </div>
                  </div>
                  <div className="settings-field">
                    <span>{copy.appearance}</span>
                    <div className="settings-segment icon-segment" aria-label={copy.appearance}>
                      <button
                        aria-label={copy.syncWithSystem}
                        className={colorTheme === "system" ? "selected" : ""}
                        onClick={() => setColorTheme("system")}
                        title={copy.syncWithSystem}
                        type="button"
                      >
                        <MaterialIcon name="desktop_windows" size={16} />
                      </button>
                      <button
                        aria-label={copy.theme.light}
                        className={colorTheme === "light" ? "selected" : ""}
                        onClick={() => setColorTheme("light")}
                        title={copy.theme.light}
                        type="button"
                      >
                        <MaterialIcon name="light_mode" size={16} />
                      </button>
                      <button
                        aria-label={copy.theme.dark}
                        className={colorTheme === "dark" ? "selected" : ""}
                        onClick={() => setColorTheme("dark")}
                        title={copy.theme.dark}
                        type="button"
                      >
                        <MaterialIcon name="dark_mode" size={16} />
                      </button>
                    </div>
                  </div>
                  <label className="settings-field" htmlFor="settings-session-id">
                    <span>{copy.session}</span>
                    <input
                      id="settings-session-id"
                      name="settings-session-id"
                      onChange={(event) => setSessionId(event.target.value)}
                      placeholder={copy.sessionPlaceholder}
                      value={sessionId}
                    />
                  </label>
                  <div className="settings-field">
                    <span>{copy.chatMode}</span>
                    <div className="settings-segment" aria-label={copy.chatMode}>
                      <button
                        className={mode === "act" ? "selected" : ""}
                        onClick={() => setMode("act")}
                        type="button"
                      >
                        Act
                      </button>
                      <button
                        className={mode === "plan" ? "selected" : ""}
                        onClick={() => setMode("plan")}
                        type="button"
                      >
                        Plan
                      </button>
                    </div>
                  </div>
                  <div className="settings-field">
                    <span>{copy.reasoning}</span>
                    <div className="settings-segment" aria-label={copy.reasoning}>
                      {reasoningOptions.map((reasoningOption) => (
                        <button
                          className={selectedReasoningEffort === reasoningOption.value ? "selected" : ""}
                          key={reasoningOption.value}
                          onClick={() => setSelectedReasoningEffort(reasoningOption.value)}
                          type="button"
                        >
                          {reasoningOption.labels[uiLanguage]}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </header>

        {activeView === "chat" ? (
          <section className="conversation" aria-label="Conversation" id="chat">
            <div className="workbench-body">
              <div className="chat-column">
                <div className="message-list" ref={messageListRef}>
                  {messages.map((message) => (
                    <MessageArticle copy={copy} key={message.id} message={message} />
                  ))}
                </div>

                {pendingApproval !== null ? (
                  <section className="approval-banner" aria-label={copy.approval}>
                    <div>
                      <strong>{copy.approvalRequired}</strong>
                      <p>{pendingApproval.reason}</p>
                    </div>
                    <div className="approval-actions">
                      <button className="icon-button approve" onClick={() => decideApproval("approve")} type="button" aria-label={copy.approve}>
                        <MaterialIcon name="check" size={17} />
                      </button>
                      <button className="icon-button stop" onClick={() => decideApproval("reject")} type="button" aria-label={copy.reject}>
                        <MaterialIcon name="close" size={17} />
                      </button>
                    </div>
                  </section>
                ) : null}

                <form className="composer" onSubmit={handleSubmit}>
                  <textarea
                    aria-label={copy.messageLabel}
                    id="message"
                    name="message"
                    onKeyDown={handleComposerKeyDown}
                    onChange={(event) => setInput(event.target.value)}
                    placeholder={copy.placeholder}
                    ref={messageTextareaRef}
                    rows={2}
                    value={input}
                  />
                  <div className="composer-actions">
                    <div className="mode-control" aria-label={copy.chatMode}>
                      <button
                        className={mode === "act" ? "selected" : ""}
                        onClick={() => setMode("act")}
                        type="button"
                      >
                        Act
                      </button>
                      <button
                        className={mode === "plan" ? "selected" : ""}
                        onClick={() => setMode("plan")}
                        type="button"
                      >
                        Plan
                      </button>
                    </div>
                    <div className="composer-right-tools">
                      <div
                        className={isModelMenuOpen ? "model-picker open" : "model-picker"}
                        onMouseLeave={() => setIsModelMenuOpen(false)}
                      >
                        <button
                          aria-expanded={isModelMenuOpen}
                          aria-haspopup="menu"
                          className="model-trigger"
                          onClick={() => setIsModelMenuOpen((current) => !current)}
                          onMouseEnter={() => setIsModelMenuOpen(true)}
                          type="button"
                        >
                          {selectedReasoningLabel}
                          <MaterialIcon name="keyboard_arrow_down" size={15} />
                        </button>
                        <div className="model-menu" role="menu" aria-label="OpenAI reasoning effort">
                          <div className="model-menu-title" aria-hidden="true">
                            {copy.modelMenuTitle}
                          </div>
                          {reasoningOptions.map((reasoningOption) => (
                            <button
                              aria-checked={selectedReasoningEffort === reasoningOption.value}
                              className={selectedReasoningEffort === reasoningOption.value ? "selected" : ""}
                              key={reasoningOption.value}
                              onClick={() => {
                                setSelectedReasoningEffort(reasoningOption.value);
                                setIsModelMenuOpen(false);
                              }}
                              role="menuitemradio"
                              type="button"
                            >
                              {reasoningOption.labels[uiLanguage]}
                            </button>
                          ))}
                        </div>
                      </div>
                      {isStreaming ? (
                        <button className="icon-button stop" onClick={handleStop} type="button" aria-label={copy.stopStreaming}>
                          <MaterialIcon name="stop_circle" size={18} />
                        </button>
                      ) : (
                        <button className="send-button" disabled={!canSend} type="submit" aria-label={copy.sendLabel}>
                          <MaterialIcon name="send" size={17} />
                          <span className="send-label">{copy.send}</span>
                        </button>
                      )}
                    </div>
                  </div>
                </form>
              </div>
              <ActivityPanel className="docked" copy={copy} items={visibleActivityItems} />
            </div>
          </section>
        ) : (
          <section className="activity-page" aria-label={copy.activityTitle} id="activity">
            <ActivityPanel copy={copy} items={visibleActivityItems} />
          </section>
        )}
      </section>
    </main>
  );
}
