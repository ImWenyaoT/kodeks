// frontend/lib/i18n.test.ts
import { describe, it, expect } from "vitest";
import { copy, resolveLanguage } from "@/lib/i18n";

describe("i18n", () => {
  // zh/en 必须保持完全一致的键集合（parity）
  it("has zh and en dictionaries with matching keys", () => {
    expect(Object.keys(copy.zh).sort()).toEqual(Object.keys(copy.en).sort());
  });

  // resolveLanguage 将 zh-* 映射为 zh，其余回退到 en
  it("resolveLanguage maps zh-* to zh, otherwise en", () => {
    expect(resolveLanguage("zh-CN")).toBe("zh");
    expect(resolveLanguage("en-US")).toBe("en");
  });

  // 大小写不敏感：ZH 同样应解析为 zh
  it("resolveLanguage is case-insensitive", () => {
    expect(resolveLanguage("ZH")).toBe("zh");
  });

  // 非 zh 标签回退到 en
  it("resolveLanguage falls back to en for non-zh tags", () => {
    expect(resolveLanguage("fr")).toBe("en");
  });
});
