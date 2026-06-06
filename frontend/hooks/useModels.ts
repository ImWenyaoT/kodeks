// frontend/hooks/useModels.ts
// 模型目录加载 hook：把 API 客户端（getModels）与 chat-store 粘合在一起。
// 职责：1) 挂载时拉取已配置的模型目录并缓存到本地 state；
//       2) 派生去重后的 provider 列表与「当前 provider 的模型子集」；
//       3) 在 store 尚未选定 model 时，按 primary（否则首个）一次性播种选择，
//          且加守卫避免在重渲染时覆盖用户已做的选择。
// 注意：本 hook 不触发 bridge 预检（那是 Task 4.7 的职责，会监听 store.model 变化）。
import { useEffect, useMemo, useRef, useState } from "react";

import { getModels, type ModelOption } from "@/lib/api";
import { useChatStore } from "@/stores/chat-store";

/** 去重后的 provider 选项（用于 provider 下拉）。 */
export interface ProviderOption {
  /** provider 的稳定标识（即 store.providerId 的取值）。 */
  id: string;
  /** 展示名：优先 providerName，缺省回退到 id。 */
  name: string;
}

/** useModels 的对外接口。 */
export interface ModelsApi {
  /** 全部已配置的模型（已由 getModels 过滤 configured）。 */
  models: ModelOption[];
  /** 去重后的 provider 列表（按目录中首次出现的顺序）。 */
  providers: ProviderOption[];
  /** 是否正在首次加载目录。 */
  loading: boolean;
  /** 加载是否失败（true 时上层可展示错误态）。 */
  error: boolean;
  /** 当前 store.providerId 对应的模型子集（供 model 下拉直接消费）。 */
  modelsForCurrentProvider: ModelOption[];
}

/**
 * 模型目录 hook。
 * 挂载时拉取一次目录；成功后若 store 尚无 model 选择，则按 primary（否则首个）
 * 播种 model/providerId。seededRef 守卫确保播种只发生一次，绝不覆盖用户后续选择。
 */
export function useModels(): ModelsApi {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // 播种守卫：一旦播种过（或检测到 store 已有 model），就不再自动写入 store。
  const seededRef = useRef(false);

  // 仅订阅 providerId，用于派生「当前 provider 的模型子集」；变化时触发重算。
  const providerId = useChatStore((s) => s.providerId);

  // 挂载即加载目录。组件卸载后通过 alive 守卫避免在已卸载组件上 setState。
  // 说明：loading/error 的初值（true/false）已覆盖挂载场景，故无需在 effect 顶部
  // 同步重置（那会触发 react-hooks/set-state-in-effect 的级联渲染告警）；
  // 状态推进全部放进 then/catch/finally 这些异步回调里。
  useEffect(() => {
    let alive = true;
    getModels()
      .then((catalog) => {
        if (!alive) return;
        setModels(catalog.models);

        // 仅在 store 未选定 model 且尚未播种过时，播种一次默认选择。
        const store = useChatStore.getState();
        if (!seededRef.current && !store.model && catalog.models.length > 0) {
          const chosen =
            catalog.models.find((m) => m.ref === catalog.primary) ??
            catalog.models[0];
          store.setSettings({ model: chosen.ref, providerId: chosen.providerId });
          seededRef.current = true;
        }
      })
      .catch(() => {
        if (alive) setError(true);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // 派生去重的 provider 列表：保持目录中首次出现的顺序，名称优先取 providerName。
  const providers = useMemo<ProviderOption[]>(() => {
    const seen = new Set<string>();
    const out: ProviderOption[] = [];
    for (const m of models) {
      if (seen.has(m.providerId)) continue;
      seen.add(m.providerId);
      out.push({ id: m.providerId, name: m.providerName ?? m.providerId });
    }
    return out;
  }, [models]);

  // 当前 provider 的模型子集：providerId 为空时返回空数组。
  const modelsForCurrentProvider = useMemo(
    () => models.filter((m) => m.providerId === providerId),
    [models, providerId],
  );

  return { models, providers, loading, error, modelsForCurrentProvider };
}
