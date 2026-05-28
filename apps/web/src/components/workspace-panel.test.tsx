import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import WorkspacePanel from './workspace-panel';
import { uiCopy } from '@/lib/ui-copy';

const noop = () => {};

// Renders the workspace panel with stable callbacks so the sidebar contract is easy to assert.
function renderWorkspacePanel() {
  return renderToStaticMarkup(
    createElement(WorkspacePanel, {
      collapsed: false,
      copy: uiCopy.zh.tools,
      currentSessionId: '',
      onCollapseToggle: noop,
      onNewSession: noop,
      onSelectedFilesChange: noop,
      onSessionSelect: noop,
      selectedFiles: []
    })
  );
}

// Renders the compact rail state that mirrors ChatGPT's collapsed sidebar.
function renderCollapsedWorkspacePanel() {
  return renderToStaticMarkup(
    createElement(WorkspacePanel, {
      collapsed: true,
      copy: uiCopy.zh.tools,
      currentSessionId: '',
      onCollapseToggle: noop,
      onNewSession: noop,
      onSelectedFilesChange: noop,
      onSessionSelect: noop,
      selectedFiles: []
    })
  );
}

describe('WorkspacePanel', () => {
  it('renders ChatGPT-style session and file areas', () => {
    const markup = renderWorkspacePanel();

    expect(markup).toContain('data-testid="workspace-panel"');
    expect(markup).toContain('data-testid="workspace-collapse-button"');
    expect(markup).toContain('aria-label="折叠侧边栏"');
    expect(markup).toContain('新会话');
    expect(markup).toContain('最近会话');
    expect(markup).toContain('文件搜索');
    expect(markup).toContain('选择文件');
  });

  it('renders a compact collapsed rail with an expand control', () => {
    const markup = renderCollapsedWorkspacePanel();

    expect(markup).toContain('data-state="collapsed"');
    expect(markup).toContain('data-testid="workspace-expand-button"');
    expect(markup).toContain('aria-label="展开侧边栏"');
    expect(markup).not.toContain('最近会话');
  });
});
