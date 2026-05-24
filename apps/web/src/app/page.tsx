"use client";

import { type FormEvent, type KeyboardEvent, type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  AppWindow,
  Bot,
  CalendarDays,
  Check,
  ChevronDown,
  CircleStop,
  Code2,
  Cpu,
  Gamepad2,
  Grid2X2,
  MessageSquare,
  Search,
  Send,
  Settings,
  Sparkles,
  UserRound,
  Wrench,
  X
} from "lucide-react";

import { type ChatMode, type ChatStreamEvent } from "@/lib/chat-stream";
import { sendChatMessage } from "@/lib/kodeks-api";

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
};

type ActivityItem = {
  id: string;
  label: string;
  detail: string;
};

type PendingApproval = {
  id: string;
  reason: string;
};

type SectionId = "today" | "chat" | "tools" | "runtime";

const reasoningOptions = [
  { label: "低", value: "low" },
  { label: "中", value: "medium" },
  { label: "高", value: "high" },
  { label: "超高", value: "xhigh" }
] as const;

type ReasoningOption = (typeof reasoningOptions)[number];
type ReasoningEffort = ReasoningOption["value"];

type ComposerKeyLike = {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  isComposing: boolean;
};

type DeferredDiagnosticsWindow = Window &
  typeof globalThis & {
    requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };

// Checks whether a hash value points at one of the local demo sections.
function isSectionId(value: string): value is SectionId {
  return value === "today" || value === "chat" || value === "tools" || value === "runtime";
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

// Delays non-critical diagnostics until after the first browser paint has a chance to complete.
function useDeferredDiagnostics(): boolean {
  const [shouldRenderDiagnostics, setShouldRenderDiagnostics] = useState(false);

  useEffect(() => {
    if (shouldRenderDiagnostics) {
      return undefined;
    }

    const browserWindow = window as DeferredDiagnosticsWindow;
    if (browserWindow.requestIdleCallback && browserWindow.cancelIdleCallback) {
      const idleHandle = browserWindow.requestIdleCallback(() => setShouldRenderDiagnostics(true), { timeout: 800 });
      return () => browserWindow.cancelIdleCallback?.(idleHandle);
    }

    const frameHandle = browserWindow.requestAnimationFrame(() => {
      browserWindow.setTimeout(() => setShouldRenderDiagnostics(true), 0);
    });
    return () => browserWindow.cancelAnimationFrame(frameHandle);
  }, [shouldRenderDiagnostics]);

  return shouldRenderDiagnostics;
}

// Renders the minimal interactive chat surface for the kodeks backend.
export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content: "我是 Kodeks 的最小聊天界面。输入一条消息，我会通过本地 TypeScript runtime 流式回复。"
    }
  ]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<ChatMode>("act");
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState<ReasoningEffort>("medium");
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [sessionId, setSessionId] = useState("s_demo");
  const [isStreaming, setIsStreaming] = useState(false);
  const [activeSection, setActiveSection] = useState<SectionId>("today");
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const messageTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const shouldRenderDiagnostics = useDeferredDiagnostics();

  const canSend = input.trim().length > 0 && !isStreaming;
  const statusText = useMemo(() => {
    if (isStreaming) {
      return "Streaming";
    }
    return mode === "plan" ? "Plan mode" : "Act mode";
  }, [isStreaming, mode]);
  const selectedReasoningLabel = useMemo(
    () => reasoningOptions.find((option) => option.value === selectedReasoningEffort)?.label ?? "中",
    [selectedReasoningEffort]
  );

  useEffect(() => {
    const syncSectionFromHash = () => {
      const hashSection = window.location.hash.slice(1);
      if (isSectionId(hashSection)) {
        setActiveSection(hashSection);
      }
    };

    syncSectionFromHash();
    window.addEventListener("hashchange", syncSectionFromHash);
    return () => window.removeEventListener("hashchange", syncSectionFromHash);
  }, []);

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
    setActivity([]);
    setMessages((currentMessages) => [
      ...currentMessages,
      { id: userMessageId, role: "user", content: prompt },
      { id: assistantMessageId, role: "assistant", content: "" }
    ]);

    try {
      await sendChatMessage({
        input: prompt,
        sessionId,
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
                    "请求失败了。确认本地 Next.js runtime 还在 http://127.0.0.1:3000 运行。"
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

  // Moves sidebar navigation to a real page target and keeps selected state honest.
  function handleSectionNavigation(event: MouseEvent<HTMLAnchorElement>, sectionId: SectionId) {
    event.preventDefault();
    setActiveSection(sectionId);
    window.history.replaceState(null, "", `#${sectionId}`);
    document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" });

    if (sectionId === "chat") {
      window.setTimeout(() => messageTextareaRef.current?.focus(), 180);
    }
  }

  // Writes stream errors into the active assistant bubble instead of hiding them in telemetry.
  function showAssistantError(assistantMessageId: string, message: string) {
    setMessages((currentMessages) =>
      currentMessages.map((currentMessage) =>
        currentMessage.id === assistantMessageId
          ? { ...currentMessage, content: `运行失败：${message}` }
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
    if (streamEvent.type === "assistant_status") {
      appendActivity("Status", streamEvent.message);
      return;
    }

    if (streamEvent.type === "tool_call") {
      appendActivity("Tool call", streamEvent.toolName ?? "unknown");
      return;
    }

    if (streamEvent.type === "tool_result") {
      appendActivity("Tool result", `${streamEvent.toolName ?? "unknown"}: ${streamEvent.toolStatus ?? "done"}`);
      return;
    }

    if (streamEvent.type === "response_completed") {
      appendActivity("Completed", streamEvent.responseId || "response finished");
      return;
    }

    if (streamEvent.type === "approval_required") {
      setPendingApproval({
        id: streamEvent.approvalId,
        reason: streamEvent.message
      });
      appendActivity("Approval", streamEvent.message);
      return;
    }

    if (streamEvent.type === "memory_recalled") {
      appendActivity("Memory", `${streamEvent.memoryIds.length} recalled`);
      return;
    }

    if (streamEvent.type === "subagent_started") {
      appendActivity("Subagent", `${streamEvent.agent} started`);
      return;
    }

    if (streamEvent.type === "subagent_completed") {
      appendActivity("Subagent", streamEvent.summary);
      return;
    }

    if (streamEvent.type === "error") {
      appendActivity("Error", streamEvent.message);
    }
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
      appendActivity(decision === "approve" ? "Approved" : "Rejected", approvalId);
      setPendingApproval(null);
      return;
    }

    appendActivity("Approval error", `HTTP ${response.status}`);
  }

  // Appends one telemetry row, keeping the panel short and readable.
  function appendActivity(label: string, detail: string) {
    setActivity((currentActivity) => [
      { id: crypto.randomUUID(), label, detail },
      ...currentActivity.slice(0, 5)
    ]);
  }

  return (
    <main className="app-shell">
      <aside className="store-sidebar" aria-label="Kodeks navigation">
        <div className="sidebar-brand">
          <div className="appstore-mark" aria-hidden="true">
            <Code2 size={20} />
          </div>
          <strong>Kodeks</strong>
          <span>for Mac</span>
        </div>

        <label className="sidebar-search" htmlFor="sidebar-search">
          <Search size={15} />
          <input id="sidebar-search" name="sidebar-search" placeholder="Search" readOnly value="" />
        </label>

        <nav className="sidebar-nav" aria-label="Demo sections">
          <a
            className={activeSection === "today" ? "active" : ""}
            href="#today"
            onClick={(event) => handleSectionNavigation(event, "today")}
          >
            <CalendarDays size={18} />
            Today
          </a>
          <a
            className={activeSection === "chat" ? "active" : ""}
            href="#chat"
            onClick={(event) => handleSectionNavigation(event, "chat")}
          >
            <MessageSquare size={18} />
            Chat
          </a>
          <a
            className={activeSection === "tools" ? "active" : ""}
            href="#tools"
            onClick={(event) => handleSectionNavigation(event, "tools")}
          >
            <Grid2X2 size={18} />
            Tools
          </a>
          <a
            className={activeSection === "runtime" ? "active" : ""}
            href="#runtime"
            onClick={(event) => handleSectionNavigation(event, "runtime")}
          >
            <Gamepad2 size={18} />
            Runtime
          </a>
        </nav>
      </aside>

      <div className={isSettingsOpen ? "settings-dock open" : "settings-dock"}>
        <button
          aria-expanded={isSettingsOpen}
          aria-haspopup="dialog"
          aria-label="Open settings"
          className="icon-button settings-trigger"
          onClick={() => setIsSettingsOpen((current) => !current)}
          type="button"
        >
          <Settings size={17} />
        </button>
        {isSettingsOpen ? (
          <div className="settings-panel" role="dialog" aria-label="对话设置">
            <label className="settings-field" htmlFor="settings-session-id">
              <span>会话</span>
              <input
                id="settings-session-id"
                name="settings-session-id"
                onChange={(event) => setSessionId(event.target.value)}
                value={sessionId}
              />
            </label>
            <div className="settings-field">
              <span>模式</span>
              <div className="settings-segment" aria-label="Settings chat mode">
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
              <span>智能</span>
              <div className="settings-segment" aria-label="Settings reasoning effort">
                {reasoningOptions.map((reasoningOption) => (
                  <button
                    className={selectedReasoningEffort === reasoningOption.value ? "selected" : ""}
                    key={reasoningOption.value}
                    onClick={() => setSelectedReasoningEffort(reasoningOption.value)}
                    type="button"
                  >
                    {reasoningOption.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <section className="store-main" aria-label="Kodeks chat">
        <header className="page-heading" id="today">
          <div>
            <p>Today</p>
            <h1>Kodeks Chat</h1>
          </div>
          <div className="status" aria-live="polite">
            <span className={isStreaming ? "status-dot active" : "status-dot"} />
            {statusText}
          </div>
        </header>

        <div className="today-grid">
          <section className="feature-card chat-card" aria-label="Conversation" id="chat">
            <div className="feature-card-header">
              <div>
                <span>Local runtime</span>
                <h2>Kodeks agent</h2>
              </div>
              <div className="feature-icon" aria-hidden="true">
                <Sparkles size={21} />
              </div>
            </div>

            <div className="conversation">
              <div className="message-list">
                {messages.map((message) => (
                  <article className={`message ${message.role}`} key={message.id}>
                    <div className="avatar" aria-hidden="true">
                      {message.role === "user" ? <UserRound size={17} /> : <Bot size={17} />}
                    </div>
                    <div className="bubble">
                      <span className="role-label">{message.role === "user" ? "You" : "Kodeks"}</span>
                      <p>{message.content || "..."}</p>
                    </div>
                  </article>
                ))}
              </div>

              <form className="composer" onSubmit={handleSubmit}>
                <textarea
                  aria-label="Message"
                  id="message"
                  name="message"
                  onKeyDown={handleComposerKeyDown}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder="问一句，比如：帮我解释这个项目现在能做什么"
                  ref={messageTextareaRef}
                  rows={3}
                  value={input}
                />
                <div className="composer-actions">
                  <div className="mode-control" aria-label="Chat mode">
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
                        <ChevronDown size={15} />
                      </button>
                      <div className="model-menu" role="menu" aria-label="OpenAI reasoning effort">
                        <div className="model-menu-title" aria-hidden="true">
                          智能
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
                            {reasoningOption.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    {isStreaming ? (
                      <button className="icon-button stop" onClick={handleStop} type="button" aria-label="Stop streaming">
                        <CircleStop size={18} />
                      </button>
                    ) : (
                      <button className="send-button" disabled={!canSend} type="submit" aria-label="Send message">
                        <Send size={17} />
                        <span className="send-label">Send</span>
                      </button>
                    )}
                  </div>
                </div>
              </form>
            </div>
          </section>

          <aside
            aria-busy={!shouldRenderDiagnostics}
            aria-label="Session details"
            className="today-stack"
            id="tools"
          >
            {shouldRenderDiagnostics ? (
              <>
                <section className="detail-card">
                  <label htmlFor="session-id">Session</label>
                  <input
                    id="session-id"
                    name="session-id"
                    onChange={(event) => setSessionId(event.target.value)}
                    value={sessionId}
                  />
                  <p>Use a stable session id to test multi-turn memory and resume behavior.</p>
                </section>

                {pendingApproval !== null ? (
                  <section className="detail-card">
                    <label>Approval</label>
                    <p>{pendingApproval.reason}</p>
                    <div className="approval-actions">
                      <button className="icon-button" onClick={() => decideApproval("approve")} type="button" aria-label="Approve">
                        <Check size={17} />
                      </button>
                      <button className="icon-button stop" onClick={() => decideApproval("reject")} type="button" aria-label="Reject">
                        <X size={17} />
                      </button>
                    </div>
                  </section>
                ) : null}

                <details className="activity-card runtime-log-card" id="runtime">
                  <summary className="activity-heading">
                    <Cpu size={16} />
                    <span>运行日志</span>
                    <span className="activity-count">{activity.length}</span>
                    <span className="runtime-state">{activity.length > 0 ? "Live" : "Ready"}</span>
                  </summary>
                  {activity.length === 0 ? (
                    <p className="muted">暂无事件。发送消息后会显示工具调用、审批和完成状态。</p>
                  ) : (
                    <ul className="activity-list">
                      {activity.map((item) => (
                        <li key={item.id}>
                          <span>{item.label}</span>
                          <p>{item.detail}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="runtime-log">
                    <div>
                      <AppWindow size={17} />
                      <span>TypeScript runtime</span>
                    </div>
                    <div>
                      <Wrench size={17} />
                      <span>Next proxy route</span>
                    </div>
                  </div>
                </details>
              </>
            ) : (
              <div className="diagnostics-placeholder" aria-hidden="true" />
            )}
          </aside>
        </div>
      </section>
    </main>
  );
}
