import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import Home from "./page";

describe("Home", () => {
  it("renders the Kodeks three-panel shell", () => {
    const markup = renderToStaticMarkup(createElement(Home));
    const workspacePanelIndex = markup.indexOf(
      'class="hidden min-h-0 shrink-0 overflow-hidden rounded-[16px] transition-[width] duration-200 md:block w-[64px] 2xl:w-[260px]"',
    );
    const chatIndex = markup.indexOf(
      'class="min-h-0 min-w-0 flex-1 overflow-hidden bg-white text-slate-950 shadow-sm md:rounded-[16px] md:border md:border-slate-200 dark:bg-[#202428] dark:text-slate-100 dark:border-[#343a40] dark:shadow-none"',
    );
    const debugPanelIndex = markup.indexOf(
      'class="hidden min-h-0 shrink-0 overflow-hidden rounded-[16px] transition-[width] duration-200 md:block w-[64px] 2xl:w-[340px]"',
    );

    expect(markup).toContain(
      'class="relative flex h-dvh min-h-0 justify-center overflow-hidden"',
    );
    expect(markup).toContain(
      'class="bg-[#eef2ff] text-slate-950 flex h-full min-h-0 w-full md:gap-2.5 md:p-2"',
    );
    expect(markup).toContain(
      'class="min-h-0 min-w-0 flex-1 overflow-hidden bg-white text-slate-950 shadow-sm md:rounded-[16px] md:border md:border-slate-200 dark:bg-[#202428] dark:text-slate-100 dark:border-[#343a40] dark:shadow-none"',
    );
    expect(markup).toContain(
      'class="hidden min-h-0 shrink-0 overflow-hidden rounded-[16px] transition-[width] duration-200 md:block w-[64px] 2xl:w-[260px]"',
    );
    expect(markup).toContain(
      'class="hidden min-h-0 shrink-0 overflow-hidden rounded-[16px] transition-[width] duration-200 md:block w-[64px] 2xl:w-[340px]"',
    );
    expect(workspacePanelIndex).toBeGreaterThan(-1);
    expect(chatIndex).toBeGreaterThan(-1);
    expect(debugPanelIndex).toBeGreaterThan(-1);
    expect(workspacePanelIndex).toBeLessThan(chatIndex);
    expect(chatIndex).toBeLessThan(debugPanelIndex);
    expect(markup).toContain("给 Kodeks 发送消息...");
  });

  it("keeps the tools panel sections", () => {
    const markup = renderToStaticMarkup(createElement(Home));

    expect(markup).toContain("外观");
    expect(markup).toContain("文件搜索");
    expect(markup).toContain("MoonBridge");
    expect(markup).toContain("代码解释器");
    expect(markup).toContain("函数");
    expect(markup).toContain("MCP");
    expect(markup).toContain("调试");
    expect(markup).toContain("最近会话");
  });

  it("renders language, theme, and model controls", () => {
    const markup = renderToStaticMarkup(createElement(Home));
    const selectedControlCount =
      markup.match(/aria-pressed="true"/g)?.length ?? 0;

    expect(markup).toContain("设备");
    expect(markup).toContain("中文");
    expect(markup).toContain("EN");
    expect(markup).toContain("浅色");
    expect(markup).toContain("深色");
    expect(markup).toContain("模型服务");
    expect(markup).toContain("模型");
    expect(markup).toContain('data-language="zh"');
    expect(markup).toContain('data-theme="light"');
    expect(selectedControlCount).toBe(2);
  });

  it("keeps SSR preference copy on the hydration-safe baseline", () => {
    const markup = renderToStaticMarkup(createElement(Home));
    const selectedSystemControlCount =
      markup.match(/aria-pressed="true"[^>]*>设备<\/button>/g)?.length ?? 0;

    expect(markup).toContain('data-language="zh"');
    expect(markup).toContain('data-theme="light"');
    expect(selectedSystemControlCount).toBe(2);
    expect(markup).toContain("外观");
    expect(markup).not.toContain("copy.preferences");
    expect(markup).not.toContain("Interface");
    expect(markup).not.toContain('class="dark flex h-full');
  });

  it("uses Material-style icons instead of font ligature text", () => {
    const markup = renderToStaticMarkup(createElement(Home));

    expect(markup).toContain("<svg");
    expect(markup).not.toContain(">code_blocks<");
    expect(markup).not.toContain(">smart_toy<");
  });
});
