import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import Home, { shouldSubmitComposerKey } from "./page";

describe("Home", () => {
  it("does not expose debug panels in the formal navigation", () => {
    const markup = renderToStaticMarkup(createElement(Home));

    expect(markup).toContain('class="app-shell sidebar-open"');
    expect(markup).toContain("收起侧栏");
    expect(markup).toContain('aria-label="主导航"');
    expect(markup).toContain("新对话");
    expect(markup).toContain("Chat");
    expect(markup).toContain("活动");
    expect(markup).toContain('class="session-card active"');
    expect(markup).not.toContain(">Tools<");
    expect(markup).not.toContain(">Runtime<");
    expect(markup).not.toContain('aria-label="Session details"');
    expect(markup).not.toContain('class="diagnostics-placeholder"');
    expect(markup).not.toContain("运行日志");
  });

  it("renders settings in the header app dock instead of the composer", () => {
    const markup = renderToStaticMarkup(createElement(Home));
    const composerStart = markup.indexOf('class="composer"');
    const composerEnd = markup.indexOf("</form>", composerStart);
    const composerMarkup = markup.slice(composerStart, composerEnd);

    expect(markup).toContain('class="settings-dock"');
    expect(markup).toContain("打开设置");
    expect(composerMarkup).not.toContain("打开设置");
  });

  it("keeps agent capabilities in the docked activity inspector", () => {
    const markup = renderToStaticMarkup(createElement(Home));

    expect(markup).toContain("活动");
    expect(markup).toContain('class="activity-panel docked"');
    expect(markup).toContain("危险 shell 命令会暂停并等待确认");
  });

  it("submits with Enter while preserving multiline input shortcuts", () => {
    expect(shouldSubmitComposerKey({ key: "Enter", shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, isComposing: false })).toBe(true);
    expect(shouldSubmitComposerKey({ key: "Enter", shiftKey: true, altKey: false, metaKey: false, ctrlKey: false, isComposing: false })).toBe(false);
    expect(shouldSubmitComposerKey({ key: "Enter", shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, isComposing: true })).toBe(false);
    expect(shouldSubmitComposerKey({ key: "a", shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, isComposing: false })).toBe(false);
  });
});
