import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import Home from './page';

describe('Home', () => {
  it('renders the Kodeks three-panel shell', () => {
    const markup = renderToStaticMarkup(createElement(Home));
    const workspacePanelIndex = markup.indexOf(
      'class="hidden min-h-0 shrink-0 overflow-hidden rounded-[18px] transition-[width] duration-200 md:block w-[260px]"'
    );
    const chatIndex = markup.indexOf(
      'class="min-h-0 min-w-0 flex-1 overflow-hidden bg-white md:rounded-[18px] md:border md:border-stone-200 dark:bg-black md:dark:border-zinc-800"'
    );
    const debugPanelIndex = markup.indexOf(
      'class="hidden min-h-0 w-[340px] shrink-0 overflow-hidden rounded-[18px] lg:block"'
    );

    expect(markup).toContain(
      'class="relative flex h-dvh min-h-0 justify-center overflow-hidden"'
    );
    expect(markup).toContain(
      'class="bg-white text-zinc-950 md:bg-zinc-200 flex h-full min-h-0 w-full md:gap-2.5 md:p-2"'
    );
    expect(markup).toContain(
      'class="min-h-0 min-w-0 flex-1 overflow-hidden bg-white md:rounded-[18px] md:border md:border-stone-200 dark:bg-black md:dark:border-zinc-800"'
    );
    expect(markup).toContain(
      'class="hidden min-h-0 shrink-0 overflow-hidden rounded-[18px] transition-[width] duration-200 md:block w-[260px]"'
    );
    expect(markup).toContain(
      'class="hidden min-h-0 w-[340px] shrink-0 overflow-hidden rounded-[18px] lg:block"'
    );
    expect(workspacePanelIndex).toBeGreaterThan(-1);
    expect(chatIndex).toBeGreaterThan(-1);
    expect(debugPanelIndex).toBeGreaterThan(-1);
    expect(workspacePanelIndex).toBeLessThan(chatIndex);
    expect(chatIndex).toBeLessThan(debugPanelIndex);
    expect(markup).toContain('给 Kodeks 发送消息...');
  });

  it('keeps the tools panel sections', () => {
    const markup = renderToStaticMarkup(createElement(Home));

    expect(markup).toContain('界面');
    expect(markup).toContain('文件搜索');
    expect(markup).toContain('网页搜索');
    expect(markup).toContain('代码解释器');
    expect(markup).toContain('函数');
    expect(markup).toContain('MCP');
    expect(markup).toContain('调试');
    expect(markup).toContain('最近会话');
  });

  it('renders language, theme, and provider controls', () => {
    const markup = renderToStaticMarkup(createElement(Home));
    const selectedControlCount =
      markup.match(/aria-pressed="true"/g)?.length ?? 0;

    expect(markup).toContain('设备');
    expect(markup).toContain('中文');
    expect(markup).toContain('EN');
    expect(markup).toContain('浅色');
    expect(markup).toContain('深色');
    expect(markup).toContain('模型服务');
    expect(markup).toContain('MoonBridge');
    expect(markup).toContain('data-language="zh"');
    expect(markup).toContain('data-theme="light"');
    expect(selectedControlCount).toBe(3);
  });

  it('keeps SSR preference copy on the hydration-safe baseline', () => {
    const markup = renderToStaticMarkup(createElement(Home));
    const selectedSystemControlCount =
      markup.match(/aria-pressed="true"[^>]*>设备<\/button>/g)?.length ?? 0;

    expect(markup).toContain('data-language="zh"');
    expect(markup).toContain('data-theme="light"');
    expect(selectedSystemControlCount).toBe(2);
    expect(markup).toContain('界面');
    expect(markup).not.toContain('copy.preferences');
    expect(markup).not.toContain('Interface');
    expect(markup).not.toContain('class="dark flex h-full');
  });

  it('uses Material-style icons instead of font ligature text', () => {
    const markup = renderToStaticMarkup(createElement(Home));

    expect(markup).toContain('<svg');
    expect(markup).not.toContain('>code_blocks<');
    expect(markup).not.toContain('>smart_toy<');
  });
});
