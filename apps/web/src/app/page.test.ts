import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import Home, { shouldSubmitComposerKey } from "./page";

describe("Home", () => {
  it("defers right-rail diagnostics out of the first static render", () => {
    const markup = renderToStaticMarkup(createElement(Home));

    expect(markup).toContain('aria-label="Session details"');
    expect(markup).toContain('class="diagnostics-placeholder"');
    expect(markup).not.toContain('for="session-id"');
    expect(markup).not.toContain("Use a stable session id");
    expect(markup).not.toContain("运行日志");
    expect(markup).not.toContain("Stream Activity");
    expect(markup).not.toContain("Tool calls, approvals, and completions.");
  });

  it("renders settings in the bottom-left app dock instead of the composer", () => {
    const markup = renderToStaticMarkup(createElement(Home));
    const composerStart = markup.indexOf('class="composer"');
    const composerEnd = markup.indexOf("</form>", composerStart);
    const composerMarkup = markup.slice(composerStart, composerEnd);

    expect(markup).toContain('class="settings-dock"');
    expect(markup).toContain("Open settings");
    expect(composerMarkup).not.toContain("Open settings");
  });

  it("submits with Enter while preserving multiline input shortcuts", () => {
    expect(shouldSubmitComposerKey({ key: "Enter", shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, isComposing: false })).toBe(true);
    expect(shouldSubmitComposerKey({ key: "Enter", shiftKey: true, altKey: false, metaKey: false, ctrlKey: false, isComposing: false })).toBe(false);
    expect(shouldSubmitComposerKey({ key: "Enter", shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, isComposing: true })).toBe(false);
    expect(shouldSubmitComposerKey({ key: "a", shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, isComposing: false })).toBe(false);
  });
});
