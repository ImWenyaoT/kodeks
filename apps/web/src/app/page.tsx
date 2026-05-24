"use client";

import { FormEvent, useMemo, useRef, useState } from "react";
import {
  AppWindow,
  Bot,
  CalendarDays,
  ChevronDown,
  CircleStop,
  Code2,
  Cpu,
  Gamepad2,
  Grid2X2,
  MessageSquare,
  Search,
  Send,
  Sparkles,
  Terminal,
  UserRound,
  Wrench
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

const modelOptions = ["Pro", "Reasoner", "Lite"] as const;

type ModelOption = (typeof modelOptions)[number];

// Renders the minimal interactive chat surface for the kodeks backend.
export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content: "我是 Kodeks 的最小聊天界面。输入一条消息，我会通过本地 FastAPI 后端流式回复。"
    }
  ]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<ChatMode>("act");
  const [selectedModel, setSelectedModel] = useState<ModelOption>("Pro");
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [sessionId, setSessionId] = useState("s_demo");
  const [isStreaming, setIsStreaming] = useState(false);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);

  const canSend = input.trim().length > 0 && !isStreaming;
  const statusText = useMemo(() => {
    if (isStreaming) {
      return "Streaming";
    }
    return mode === "plan" ? "Plan mode" : "Act mode";
  }, [isStreaming, mode]);

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
                    "请求失败了。确认 FastAPI 后端还在 http://127.0.0.1:8000 运行。"
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

  // Cancels the current browser-side request without clearing the conversation.
  function handleStop() {
    abortControllerRef.current?.abort();
    setIsStreaming(false);
  }

  // Adds compact stream telemetry so tool calls and completion are visible.
  function recordStreamEvent(streamEvent: ChatStreamEvent) {
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

    if (streamEvent.type === "error") {
      appendActivity("Error", streamEvent.message);
    }
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
          <a className="active" href="#today">
            <CalendarDays size={18} />
            Today
          </a>
          <a href="#chat">
            <MessageSquare size={18} />
            Chat
          </a>
          <a href="#tools">
            <Grid2X2 size={18} />
            Tools
          </a>
          <a href="#runtime">
            <Gamepad2 size={18} />
            Runtime
          </a>
        </nav>
      </aside>

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
                <span>Featured Demo</span>
                <h2>Talk to your local coding agent</h2>
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
                  onChange={(event) => setInput(event.target.value)}
                  placeholder="问一句，比如：帮我解释这个项目现在能做什么"
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
                        {selectedModel}
                        <ChevronDown size={15} />
                      </button>
                      <div className="model-menu" role="menu" aria-label="DeepSeek model tier">
                        {modelOptions.map((modelOption) => (
                          <button
                            aria-checked={selectedModel === modelOption}
                            className={selectedModel === modelOption ? "selected" : ""}
                            key={modelOption}
                            onClick={() => {
                              setSelectedModel(modelOption);
                              setIsModelMenuOpen(false);
                            }}
                            role="menuitemradio"
                            type="button"
                          >
                            {modelOption}
                          </button>
                        ))}
                      </div>
                    </div>
                    {isStreaming ? (
                      <button className="icon-button stop" onClick={handleStop} type="button" aria-label="Stop streaming">
                        <CircleStop size={18} />
                      </button>
                    ) : (
                      <button className="send-button" disabled={!canSend} type="submit">
                        <Send size={17} />
                        Send
                      </button>
                    )}
                  </div>
                </div>
              </form>
            </div>
          </section>

          <aside className="today-stack" aria-label="Session details" id="tools">
            <section className="lockup-card">
              <div className="lockup-icon blue" aria-hidden="true">
                <Terminal size={22} />
              </div>
              <div className="lockup-copy">
                <h3>Stream Activity</h3>
                <p>Tool calls, approvals, and completions.</p>
              </div>
              <span className="get-button">{activity.length > 0 ? "Live" : "Ready"}</span>
            </section>

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

            <section className="activity-card">
              <div className="activity-heading">
                <Cpu size={16} />
                Event log
              </div>
              {activity.length === 0 ? (
                <p className="muted">Nothing yet. Send a message to watch the stream.</p>
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
            </section>

            <section className="runtime-card" id="runtime">
              <div>
                <AppWindow size={17} />
                <span>FastAPI backend</span>
              </div>
              <div>
                <Wrench size={17} />
                <span>Next proxy route</span>
              </div>
            </section>
          </aside>
        </div>
      </section>
    </main>
  );
}
