import { defaultToolDefinitions } from '@kodeks/tools/definitions';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import ToolsPanel, { formatToolSignature } from './tools-panel';
import { uiCopy } from '@/lib/ui-copy';

const noop = () => {};

// Renders the panel with stable props so tests can assert the registry-backed function list.
function renderToolsPanel() {
  return renderToStaticMarkup(
    createElement(ToolsPanel, {
      activityCount: 0,
      copy: uiCopy.zh.tools,
      language: 'zh',
      mode: 'act',
      onLanguageChange: noop,
      onModeChange: noop,
      onProviderChange: noop,
      onThemeChange: noop,
      provider: 'moonbridge',
      reasoningEffort: 'medium',
      sessionId: 'session_test',
      theme: 'light'
    })
  );
}

describe('ToolsPanel', () => {
  it('formats function signatures from JSON schema required fields', () => {
    expect(defaultToolDefinitions.map(formatToolSignature)).toEqual([
      'read_file(path: string)',
      'write_file(path: string, content: string)',
      'grep(query: string, limit?: integer)',
      'web_search(query: string, count?: integer, country?: string)',
      'run_shell(command: string)',
      'remember_fact(content: string, scope?: string)',
      'recall_memory(query: string, limit?: integer, layers?: array)',
      'read_memory_artifact(refId: string)',
      'spawn_explore_agent(task: string)',
      'list_mcp_servers()',
      'list_skills(query?: string, limit?: integer)',
      'read_skill(name: string)'
    ]);
  });

  it('renders every registered tool instead of a hand-written function list', () => {
    const markup = renderToolsPanel();

    for (const tool of defaultToolDefinitions) {
      expect(markup).toContain(formatToolSignature(tool));
    }
    expect(markup).toContain('remember_fact(content: string, scope?: string)');
    expect(markup).toContain(
      'recall_memory(query: string, limit?: integer, layers?: array)'
    );
    expect(markup).toContain('read_memory_artifact(refId: string)');
    expect(markup).toContain('spawn_explore_agent(task: string)');
  });

  it('renders the session provider picker', () => {
    const markup = renderToolsPanel();

    expect(markup).toContain('模型服务');
    expect(markup).toContain('OpenAI');
    expect(markup).toContain('MoonBridge');
    expect(markup).toContain('DeepSeek');
  });
});
