// 解析模型返回的 tool arguments；解析失败时返回空对象，避免 runtime 被坏 JSON 打断。
export function parseToolArguments(
  argumentsText: string | undefined,
): Record<string, unknown> {
  if (argumentsText === undefined || argumentsText.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// 把本地参数对象稳定地序列化成 provider 需要的字符串格式。
export function stringifyToolArguments(args: Record<string, unknown>): string {
  return JSON.stringify(args);
}
