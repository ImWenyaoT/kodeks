import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import Chat from './chat';
import type { TimelineItem } from '@/lib/conversation-timeline';
import { uiCopy } from '@/lib/ui-copy';

const noop = () => {};

// Renders the composer shell with stable callbacks so accessibility markup can be asserted.
function renderChat(items: TimelineItem[] = []) {
  return renderToStaticMarkup(
    createElement(Chat, {
      copy: uiCopy.zh,
      isAssistantLoading: false,
      items,
      onApprovalResponse: noop,
      onSendMessage: noop,
      onStop: noop
    })
  );
}

describe('Chat', () => {
  it('labels the icon-only send button for assistive technology', () => {
    const markup = renderChat();

    expect(markup).toContain('data-testid="send-button"');
    expect(markup).toContain('aria-label="发送消息"');
  });

  it('renders backend runtime errors as visible chat timeline items', () => {
    const markup = renderChat([
      {
        type: 'error',
        id: 'error-1',
        message: 'MoonBridge could not start because port is already in use.'
      }
    ]);

    expect(markup).toContain('后端错误');
    expect(markup).toContain('MoonBridge could not start');
  });
});
