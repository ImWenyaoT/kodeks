import { describe, expect, it } from "vitest";

import {
  defaultUiLanguagePreference,
  defaultUiThemePreference,
  localizeAssistantMessageContent,
  parseUiLanguagePreference,
  parseUiThemePreference,
  readUiLanguagePreference,
  readUiThemePreference,
  resolveUiLanguage,
  resolveUiTheme,
  uiCopy,
  writeUiPreference
} from "./ui-copy";

function createStorage(initialValues: Record<string, string | null> = {}) {
  const values = new Map(Object.entries(initialValues).filter((entry): entry is [string, string] => entry[1] !== null));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    values
  };
}

describe("ui copy preferences", () => {
  it("defaults invalid language and theme preferences to system", () => {
    expect(parseUiLanguagePreference(null)).toBe(defaultUiLanguagePreference);
    expect(parseUiLanguagePreference("fr")).toBe(defaultUiLanguagePreference);
    expect(parseUiThemePreference(null)).toBe(defaultUiThemePreference);
    expect(parseUiThemePreference("solarized")).toBe(defaultUiThemePreference);
  });

  it("keeps supported language and theme preferences", () => {
    expect(parseUiLanguagePreference("system")).toBe("system");
    expect(parseUiLanguagePreference("zh")).toBe("zh");
    expect(parseUiLanguagePreference("en")).toBe("en");
    expect(parseUiThemePreference("system")).toBe("system");
    expect(parseUiThemePreference("light")).toBe("light");
    expect(parseUiThemePreference("dark")).toBe("dark");
  });

  it("resolves system mode against browser-derived values", () => {
    expect(resolveUiLanguage("system", "en")).toBe("en");
    expect(resolveUiLanguage("zh", "en")).toBe("zh");
    expect(resolveUiTheme("system", "dark")).toBe("dark");
    expect(resolveUiTheme("light", "dark")).toBe("light");
  });

  it("reads and writes localStorage preferences without throwing", () => {
    const storage = createStorage({
      "kodeks.ui.language": "en",
      "kodeks.ui.theme": "dark"
    });

    expect(readUiLanguagePreference(storage, "kodeks.ui.language")).toBe("en");
    expect(readUiThemePreference(storage, "kodeks.ui.theme")).toBe("dark");
    expect(writeUiPreference(storage, "kodeks.ui.language", "zh")).toBe(true);
    expect(storage.values.get("kodeks.ui.language")).toBe("zh");
  });

  it("falls back to system when browser storage is unavailable", () => {
    const storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      }
    };

    expect(readUiLanguagePreference(storage, "kodeks.ui.language")).toBe("system");
    expect(readUiThemePreference(storage, "kodeks.ui.theme")).toBe("system");
    expect(writeUiPreference(storage, "kodeks.ui.language", "en")).toBe(false);
  });

  it("re-localizes welcome and framework errors when the UI language changes", () => {
    expect(localizeAssistantMessageContent(uiCopy.zh.app.welcome, uiCopy.en)).toBe(uiCopy.en.app.welcome);
    expect(localizeAssistantMessageContent(uiCopy.en.app.welcome, uiCopy.zh)).toBe(uiCopy.zh.app.welcome);
    expect(localizeAssistantMessageContent(uiCopy.zh.app.requestFailed, uiCopy.en)).toBe(uiCopy.en.app.requestFailed);
    expect(localizeAssistantMessageContent("Runtime failed: socket closed", uiCopy.zh)).toBe("运行失败：socket closed");
    expect(localizeAssistantMessageContent("运行失败：连接已断开", uiCopy.en)).toBe("Runtime failed: 连接已断开");
  });

  it("does not translate real assistant content that merely passes through chat", () => {
    const content = "Runtime notes: keep the output in English.";

    expect(localizeAssistantMessageContent(content, uiCopy.zh)).toBe(content);
  });

  it("keeps preference labels as user-facing copy instead of internal keys", () => {
    expect(uiCopy.zh.tools.preferences).toBe("界面");
    expect(uiCopy.en.tools.preferences).toBe("Interface");
    expect(Object.values(uiCopy.zh.tools)).not.toContain("copy.preferences");
    expect(Object.values(uiCopy.en.tools)).not.toContain("copy.preferences");
  });
});
