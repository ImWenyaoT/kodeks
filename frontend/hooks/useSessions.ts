// frontend/hooks/useSessions.ts
// 会话列表的加载 / 选择 / 新建 hook。把 API 客户端（getSessions/getSession）与
// chat-store 粘合在一起：列表数据留在本地 state，选择会话时把历史转录灌入全局 store。
import { useCallback, useEffect, useState } from "react";

import { getSessions, getSession, type SessionSummary } from "@/lib/api";
import { useChatStore } from "@/stores/chat-store";

/** useSessions 的对外接口。 */
export interface SessionsApi {
  /** 会话摘要列表（最新在前，由后端顺序决定）。 */
  sessions: SessionSummary[];
  /** 是否正在加载列表。 */
  loading: boolean;
  /** 列表加载是否失败（true 时展示错误态）。 */
  error: boolean;
  /** 重新拉取会话列表。 */
  reload: () => Promise<void>;
  /** 选择某个会话：拉取详情并把历史消息灌入 store。 */
  select: (id: string) => Promise<void>;
  /** 新建会话：清空当前转录（保留设置）并刷新列表。 */
  newSession: () => void;
}

/**
 * 从任意形态的消息 content 中提取可展示的纯文本。
 * 兼容三种后端形态：纯字符串、{ text } 对象、内容分块数组（取各块 text 拼接）；
 * 其余情况（null/undefined → 空串；对象 → JSON 字符串）做兜底，保证返回 string。
 * @param content StoredMessage.content（类型不确定，故 unknown）。
 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (
    content &&
    typeof content === "object" &&
    "text" in content &&
    typeof (content as { text: unknown }).text === "string"
  ) {
    return (content as { text: string }).text;
  }
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p.text === "string" ? p.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

/**
 * 会话列表 hook。
 * 挂载时自动 reload 一次；select 会重置 store（清空旧转录、保留设置）后按消息顺序
 * 重建 user/assistant 气泡；newSession 仅清空运行态并刷新列表。
 */
export function useSessions(): SessionsApi {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // 拉取列表的核心实现：成功写入数据并清错误，失败置错误态，结束后退出 loading。
  // 所有 setState 都在 promise 回调中执行（非 effect 同步体），挂载首拉则复用初始的
  // loading=true / error=false。
  const fetchSessions = useCallback(
    () =>
      getSessions()
        .then((list) => {
          setSessions(list);
          setError(false);
        })
        .catch(() => {
          setError(true);
        })
        .finally(() => {
          setLoading(false);
        }),
    [],
  );

  // 手动重拉：显式进入 loading、清错误后再拉取（供 reload / newSession 复用）。
  const reload = useCallback(async () => {
    setLoading(true);
    setError(false);
    await fetchSessions();
  }, [fetchSessions]);

  // 挂载即加载一次。初始 loading 已为 true、error 已为 false，故首拉直接复用
  // fetchSessions；其内部 setState 仅在 promise 回调中触发，不在 effect 同步体内，
  // 规避 react-hooks/set-state-in-effect。fetchSessions 引用稳定（无依赖），不会重复触发。
  useEffect(() => {
    void fetchSessions();
  }, [fetchSessions]);

  // 选择会话：拉详情 → 重置 store（保留设置）→ 绑定会话 id → 逐条重建转录。
  const select = useCallback(async (id: string) => {
    const { messages } = await getSession(id);
    const store = useChatStore.getState();
    store.reset();
    store.setSession(id);
    for (const msg of messages) {
      // 仅重建用户与助手消息；runtime/其它角色不进入气泡转录。
      if (msg.role !== "user" && msg.role !== "assistant") continue;
      const text = extractText(msg.content);
      // 跳过空文本，避免重建出空气泡。
      if (text) store.appendMessage(msg.role, text);
    }
  }, []);

  // 新建会话：清空运行态（保留设置），并刷新列表以反映可能的最新数据。
  const newSession = useCallback(() => {
    useChatStore.getState().reset();
    void reload();
  }, [reload]);

  return { sessions, loading, error, reload, select, newSession };
}
