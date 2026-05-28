import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import Home from './page';

describe('Home', () => {
  it('renders the Kodeks two-column shell', () => {
    const markup = renderToStaticMarkup(createElement(Home));
    const panelIndex = markup.indexOf(
      'class="hidden min-h-0 w-[30%] min-w-[320px] max-w-[460px] md:block"'
    );
    const chatIndex = markup.indexOf(
      'class="min-h-0 min-w-0 flex-1 bg-white dark:bg-zinc-950 md:w-[70%]"'
    );

    expect(markup).toContain(
      'class="relative flex h-dvh min-h-0 justify-center overflow-hidden"'
    );
    expect(markup).toContain(
      'class="min-h-0 min-w-0 flex-1 bg-white dark:bg-zinc-950 md:w-[70%]"'
    );
    expect(markup).toContain(
      'class="hidden min-h-0 w-[30%] min-w-[320px] max-w-[460px] md:block"'
    );
    expect(panelIndex).toBeGreaterThan(-1);
    expect(chatIndex).toBeGreaterThan(-1);
    expect(panelIndex).toBeLessThan(chatIndex);
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
    expect(markup).toContain('Google 集成');
  });

  it('renders language, theme, and provider controls', () => {
    const markup = renderToStaticMarkup(createElement(Home));
    const selectedControlCount =
      markup.match(/aria-pressed="true"/g)?.length ?? 0;

    expect(markup).toContain('跟随系统');
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
      markup.match(/aria-pressed="true"[^>]*>跟随系统<\/button>/g)?.length ?? 0;

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
