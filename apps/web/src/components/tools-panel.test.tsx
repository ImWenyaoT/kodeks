import { defaultToolDefinitions } from "@kodeks/tools/definitions";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import ToolsPanel, { formatToolSignature } from "./tools-panel";
import { uiCopy } from "@/lib/ui-copy";

const noop = () => {};
const modelOptions = [
  {
    ref: "qwen/qwen3.6",
    providerId: "qwen",
    providerName: "qwen",
    modelId: "qwen3.6",
    modelName: "Qwen 3.6",
    api: "chat-completions" as const,
    requiresBridge: true,
    baseURL: "http://127.0.0.1:1234/v1",
    configured: true,
  },
  {
    ref: "openai/gpt-5.4-mini",
    providerId: "openai",
    providerName: "openai",
    modelId: "gpt-5.4-mini",
    modelName: "GPT 5.4 mini",
    api: "responses" as const,
    requiresBridge: false,
    configured: true,
  },
];

// Renders the panel with stable props so tests can assert the registry-backed function list.
function renderToolsPanel() {
  return renderToStaticMarkup(
    createElement(ToolsPanel, {
      activityCount: 0,
      bridgePreflight: {
        status: "ready",
        provider: "moonbridge",
        resolvedProvider: "moonbridge",
        bridgeBaseURL: "http://127.0.0.1:38440/v1",
        bridgeModel: "bridge",
        upstreamBaseURL: "http://127.0.0.1:1234/v1",
        upstreamModel: "qwen-local",
        checkedAt: "2026-05-29T00:00:00.000Z",
      },
      copy: uiCopy.zh.tools,
      language: "zh",
      mode: "act",
      modelOptions,
      onLanguageChange: noop,
      onModelChange: noop,
      onModeChange: noop,
      onThemeChange: noop,
      reasoningEffort: "medium",
      selectedModel: "qwen/qwen3.6",
      sessionId: "session_test",
      theme: "light",
    }),
  );
}

// Renders the collapsed right rail so the NotebookLM-style icon strip stays covered.
function renderCollapsedToolsPanel() {
  return renderToStaticMarkup(
    createElement(ToolsPanel, {
      activityCount: 0,
      bridgePreflight: {
        status: "checking",
        provider: "moonbridge",
      },
      collapsed: true,
      copy: uiCopy.zh.tools,
      language: "zh",
      mode: "act",
      modelOptions,
      onCollapseToggle: noop,
      onLanguageChange: noop,
      onModelChange: noop,
      onModeChange: noop,
      onThemeChange: noop,
      reasoningEffort: "medium",
      selectedModel: "qwen/qwen3.6",
      sessionId: "session_test",
      theme: "light",
    }),
  );
}

describe("ToolsPanel", () => {
  it("formats function signatures from JSON schema required fields", () => {
    expect(defaultToolDefinitions.map(formatToolSignature)).toEqual([
      "read_file(path: string)",
      "write_file(path: string, content: string)",
      "grep(query: string, limit?: integer)",
      "run_shell(command: string)",
      "remember_fact(content: string, scope?: string)",
      "recall_memory(query: string, limit?: integer, layers?: array)",
      "read_memory_artifact(refId: string)",
      "spawn_explore_agent(task: string)",
      "list_mcp_servers()",
      "list_skills(query?: string, limit?: integer)",
      "read_skill(name: string)",
    ]);
  });

  it("renders every registered tool instead of a hand-written function list", () => {
    const markup = renderToolsPanel();

    for (const tool of defaultToolDefinitions) {
      expect(markup).toContain(formatToolSignature(tool));
    }
    expect(markup).toContain("remember_fact(content: string, scope?: string)");
    expect(markup).toContain(
      "recall_memory(query: string, limit?: integer, layers?: array)",
    );
    expect(markup).toContain("read_memory_artifact(refId: string)");
    expect(markup).toContain("spawn_explore_agent(task: string)");
  });

  it("renders the Chrome-like debug panel header", () => {
    const markup = renderToolsPanel();

    expect(markup).toContain("调试");
    expect(markup).toContain("外观");
    expect(markup).toContain("浅色");
    expect(markup).toContain("深色");
    expect(markup).toContain("设备");
  });

  it("renders the configured provider and model picker without exposing MoonBridge as a choice", () => {
    const markup = renderToolsPanel();

    expect(markup).toContain("模型服务");
    expect(markup).toContain("qwen");
    expect(markup).toContain("Qwen 3.6");
    expect(markup).not.toContain('value="moonbridge"');
  });

  it("renders visible MoonBridge preflight details", () => {
    const markup = renderToolsPanel();

    expect(markup).toContain("Bridge 已就绪");
    expect(markup).toContain("http://127.0.0.1:38440/v1");
    expect(markup).toContain("http://127.0.0.1:1234/v1");
    expect(markup).toContain("qwen-local");
    expect(markup).toContain('aria-label="重新预检 MoonBridge"');
  });

  it("renders recovered MoonBridge endpoint and ready reason", () => {
    const markup = renderToStaticMarkup(
      createElement(ToolsPanel, {
        activityCount: 0,
        bridgePreflight: {
          status: "ready",
          provider: "moonbridge",
          resolvedProvider: "moonbridge",
          code: "moonbridge_port_recovered",
          bridgeBaseURL: "http://127.0.0.1:49152/v1",
          bridgeModel: "bridge",
          upstreamBaseURL: "http://127.0.0.1:1234/v1",
          upstreamModel: "qwen-local",
          reason:
            "MoonBridge recovered from an occupied port at http://127.0.0.1:38440 and is running at http://127.0.0.1:49152.",
          checkedAt: "2026-05-29T00:00:00.000Z",
        },
        copy: uiCopy.zh.tools,
        language: "zh",
        mode: "act",
        modelOptions,
        onLanguageChange: noop,
        onModelChange: noop,
        onModeChange: noop,
        onThemeChange: noop,
        reasoningEffort: "medium",
        selectedModel: "qwen/qwen3.6",
        sessionId: "session_test",
        theme: "light",
      }),
    );

    expect(markup).toContain("Bridge 已就绪");
    expect(markup).toContain("http://127.0.0.1:49152/v1");
    expect(markup).toContain("MoonBridge recovered from an occupied port");
    expect(markup).toContain("原因");
  });

  it("renders a clear MoonBridge unavailable reason", () => {
    const markup = renderToStaticMarkup(
      createElement(ToolsPanel, {
        activityCount: 0,
        bridgePreflight: {
          status: "unavailable",
          provider: "moonbridge",
          reason: "Missing upstream Chat Completions configuration.",
          checkedAt: "2026-05-29T00:00:00.000Z",
        },
        copy: uiCopy.zh.tools,
        language: "zh",
        mode: "act",
        modelOptions,
        onLanguageChange: noop,
        onModelChange: noop,
        onModeChange: noop,
        onThemeChange: noop,
        reasoningEffort: "medium",
        selectedModel: "qwen/qwen3.6",
        sessionId: "session_test",
        theme: "light",
      }),
    );

    expect(markup).toContain("Bridge 不可用");
    expect(markup).toContain(
      "Missing upstream Chat Completions configuration.",
    );
    expect(markup).toContain("原因");
  });

  it("associates the reasoning selector with its visible label", () => {
    const markup = renderToolsPanel();

    expect(markup).toContain('for="reasoning-effort-select"');
    expect(markup).toContain('id="reasoning-effort-select"');
  });

  it("renders a compact collapsed rail with tool icons", () => {
    const markup = renderCollapsedToolsPanel();

    expect(markup).toContain('data-state="collapsed"');
    expect(markup).toContain('data-testid="tools-expand-button"');
    expect(markup).toContain('aria-label="展开侧边栏"');
    expect(markup).not.toContain("模型服务");
  });
});
