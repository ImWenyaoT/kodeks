// frontend/hooks/useChatStream.ts
// 驱动单个聊天 turn 的端到端 React hook：把 chat store、API 客户端、SSE 解析器
// 与事件类型粘合在一起。对外暴露 { send, stop, isRunning }。
import { useCallback, useRef } from "react";
import { useChatStore } from "@/stores/chat-store";
import { useI18n } from "@/components/providers/I18nProvider";
import { openChatStream, type ChatStreamBody } from "@/lib/api";
import { readSse } from "@/lib/sse";
import { parseRuntimeEvent, type RuntimeEvent } from "@/lib/events";

/** useChatStream 的对外接口。 */
export interface ChatStreamApi {
  /** 发送一条用户消息并以流式方式消费助手回复。 */
  send: (input: string) => Promise<void>;
  /** 中断当前正在进行的 turn。 */
  stop: () => void;
  /** 是否有 turn 正在进行（从 store 读取，随状态变化重渲染）。 */
  isRunning: boolean;
}

/**
 * 聊天流 hook。
 * 每次 send 会先把用户与（空的）助手消息写入 store，随后打开 SSE 流并把各类
 * runtime 事件分派到对应的 store action；stop 通过 AbortController 中断请求。
 */
export function useChatStream(): ChatStreamApi {
  // 本 hook 渲染在 <I18nProvider> 之内（page.tsx），故可读取当前语言文案，
  // 用于把运行失败提示本地化（中文用户看到译文而非英文字面量）。
  const { t } = useI18n();
  // 订阅 isRunning，使消费组件能据此切换发送/停止按钮等 UI。
  const isRunning = useChatStore((s) => s.isRunning);
  // 保存当前 turn 的 AbortController，供 stop() 中断；turn 结束后清空。
  const controllerRef = useRef<AbortController | null>(null);

  const send = useCallback(async (input: string) => {
    const store = useChatStore.getState();

    // 1) 写入用户消息；2) 写入空助手消息并记下其 id，后续 delta 据此寻址。
    store.appendMessage("user", input);
    const assistantId = store.appendMessage("assistant", "");

    // 3) 进入运行态，并建立可中断的请求上下文。
    store.setRunning(true);
    const controller = new AbortController();
    controllerRef.current = controller;

    // 4) 从 store 当前状态构造请求体（session_id 为空时省略以让后端新建会话）。
    const body: ChatStreamBody = {
      input,
      session_id: store.sessionId || undefined,
      mode: store.mode,
      model: store.model,
      reasoning_effort: store.reasoning,
      selected_files: [...store.selectedFiles],
    };

    // 把一个已解析的 runtime 事件分派到对应的 store action。
    const dispatch = (ev: RuntimeEvent): void => {
      const s = useChatStore.getState();
      switch (ev.type) {
        case "text_delta":
          s.appendDelta(assistantId, ev.delta);
          break;
        case "session_created":
          s.setSession(ev.sessionId);
          break;
        case "approval_required":
          s.pushApproval({ approvalId: ev.approvalId, message: ev.message });
          break;
        case "error":
          // 把错误同时呈现在助手气泡（便于用户看到）与运行事件流（携带 code）。
          s.appendDelta(assistantId, `\n${t.runtimeFailed(ev.message)}`);
          s.pushRuntime(ev.code ?? "error");
          break;
        case "unknown":
          // unknown 事件用其原始 name 作为标记。
          s.pushRuntime(ev.name);
          break;
        default:
          // 其余事件（tool_call/tool_result/plan_artifact/memory_recalled/
          // assistant_status/response_completed）用 type 作为紧凑标记。
          s.pushRuntime(ev.type);
          break;
      }
    };

    try {
      // 5) 打开流式响应；非 2xx 或无 body 视为失败。
      const res = await openChatStream(body, controller.signal);
      if (!res.ok || !res.body) {
        throw new Error(`chat failed with HTTP ${res.status}`);
      }
      // 6) 逐帧解析并分派；解析失败（null）的帧直接跳过。
      await readSse(res.body, (data) => {
        const ev = parseRuntimeEvent(data);
        if (!ev) return;
        dispatch(ev);
      });
      // 7) 正常完成：清空 controller 引用。
      controllerRef.current = null;
    } catch (err) {
      // 8) 用户主动 stop 触发的 AbortError 静默吞掉；其余错误记入运行事件与气泡。
      const name = err instanceof Error ? err.name : "";
      if (name !== "AbortError") {
        const message = err instanceof Error ? err.message : String(err);
        useChatStore.getState().pushRuntime("error");
        useChatStore
          .getState()
          .appendDelta(assistantId, `\n${t.runtimeFailed(message)}`);
      }
      controllerRef.current = null;
    } finally {
      // 无论成功、失败还是中断，都复位运行态。
      useChatStore.getState().setRunning(false);
    }
  }, [t]);

  // 中断当前 turn：触发请求的 AbortError 并立即退出运行态。
  const stop = useCallback(() => {
    controllerRef.current?.abort();
    useChatStore.getState().setRunning(false);
  }, []);

  return { send, stop, isRunning };
}
