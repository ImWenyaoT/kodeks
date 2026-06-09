// frontend/lib/format.ts
// 轻量级展示层格式化工具。当前仅含会话列表所需的相对时间戳格式化。

// 复用同一个 Intl.DateTimeFormat 实例（locale 取 undefined = 跟随运行环境），
// 避免每行重复构造的开销。格式：月 日 时:分（如 "Jun 6, 02:30 PM"）。
const sessionTimeFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * 将 ISO 时间字符串格式化为简短的「月 日 时:分」展示文案。
 * 对缺省 / 非法日期做兜底：输入为空返回空串；无法解析则原样返回原始字符串，
 * 既不抛错也不显示 "Invalid Date"。
 * @param iso 后端返回的时间字符串（updatedAt / createdAt）。
 * @returns 可直接渲染的时间文案。
 */
export function formatSessionTime(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  // getTime 为 NaN 即解析失败：退回原始字符串，避免误导性的 "Invalid Date"。
  if (Number.isNaN(date.getTime())) return iso;
  return sessionTimeFormat.format(date);
}
