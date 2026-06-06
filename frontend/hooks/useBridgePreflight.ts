// frontend/hooks/useBridgePreflight.ts
// MoonBridge 预检 hook（Task 4.7）：把 API 客户端（bridgePreflight）与 chat-store
// 的当前 model 粘合在一起。职责：
//   1) 挂载时、以及 store.model 变化时，对当前 model 发起一次 bridge 预检；
//   2) 维护本地状态机：checking（请求进行中，客户端附加态）→ 服务端返回的
//      ready / not_required / unavailable；请求抛错时落到 unavailable 并带上原因；
//   3) 暴露 refresh()，对「当前 model」重跑一次预检（用户手动重检）；
//   4) 通过 ignore 守卫规避竞态与卸载后 setState（旧请求的回调被丢弃）。
import { useCallback, useEffect, useState } from "react";

import { bridgePreflight, type BridgePreflight } from "@/lib/api";
import { useChatStore } from "@/stores/chat-store";

/**
 * 预检状态枚举。
 * "checking" 是客户端在请求飞行期间临时附加的本地态；其余三态与服务端 status 对齐。
 */
export type BridgeStatus = "checking" | "ready" | "not_required" | "unavailable";

/** useBridgePreflight 的对外接口。 */
export interface BridgePreflightApi {
  /** 当前预检状态（含客户端的 checking 态）。 */
  status: BridgeStatus;
  /** 服务端返回的预检明细；未完成或出错前可能为 null。 */
  detail: BridgePreflight | null;
  /** 对当前 model 重跑一次预检。 */
  refresh: () => void;
}

/**
 * 把任意 status 字符串收敛到已知的 BridgeStatus 联合。
 * 服务端理论上只返回 ready / not_required / unavailable；其它未知值一律按 unavailable 处理，
 * 避免渲染层出现「无对应文案/颜色」的中间态。
 */
function normalizeStatus(raw: string): BridgeStatus {
  if (raw === "ready" || raw === "not_required" || raw === "unavailable") {
    return raw;
  }
  return "unavailable";
}

/**
 * MoonBridge 预检 hook。
 * 监听 store.model：每次变化（含首次挂载）都重置为 checking 并发起预检；
 * 用 nonce/ignore 守卫确保只有「最新一次」请求能写回状态，规避竞态与卸载后 setState。
 */
export function useBridgePreflight(): BridgePreflightApi {
  // 仅订阅 model：model 变化时触发预检 effect 重跑。
  const model = useChatStore((s) => s.model);

  const [status, setStatus] = useState<BridgeStatus>("checking");
  const [detail, setDetail] = useState<BridgePreflight | null>(null);
  // 手动重检计数器：refresh() 自增以强制 effect 重跑（即便 model 未变）。
  const [nonce, setNonce] = useState(0);

  /** 触发一次重检：仅自增 nonce，真正的请求逻辑在下方 effect 内统一执行。 */
  const refresh = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    // ignore 守卫：组件卸载或本次请求被新请求取代时，丢弃其回调，避免竞态/卸载后 setState。
    let ignore = false;

    // 进入预检：立即切到 checking，让 UI 即时反馈「正在确认」。
    setStatus("checking");

    bridgePreflight(model)
      .then((result) => {
        if (ignore) return;
        setStatus(normalizeStatus(result.status));
        setDetail(result);
      })
      .catch((error: unknown) => {
        if (ignore) return;
        const reason = error instanceof Error ? error.message : String(error);
        setStatus("unavailable");
        setDetail({ status: "unavailable", reason });
      });

    return () => {
      ignore = true;
    };
    // model 或 nonce 任一变化都重跑：前者为 store 切换模型，后者为用户手动 refresh。
  }, [model, nonce]);

  return { status, detail, refresh };
}
