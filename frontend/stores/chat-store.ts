// frontend/stores/chat-store.ts
// 聊天会话的全局状态容器（Zustand v5）。
// 设计原则：所有 action 都是纯 reducer，采用不可变更新，
// 数组/Set 每次都新建引用，确保订阅组件能正确重渲染。
import { create } from "zustand";

/** 消息发送方角色：用户 / 助手 / 运行时事件。 */
export type Role = "user" | "assistant" | "runtime";

/** 单条聊天消息。 */
export interface ChatMessage {
  id: string;
  role: Role;
  text: string;
}

/** 推理强度档位。 */
export type Reasoning = "low" | "medium" | "high" | "xhigh";

/** 运行模式：执行 / 计划。 */
export type Mode = "act" | "plan";

/** 待审批项（来自 runtime 的 approval_required 事件）。 */
export interface Approval {
  approvalId: string;
  message: string;
}

/** 可被浅合并的设置子集。 */
export interface Settings {
  mode: Mode;
  model: string;
  providerId: string;
  reasoning: Reasoning;
}

/** store 的完整状态 + action 类型。 */
export interface ChatState extends Settings {
  messages: ChatMessage[];
  sessionId: string;
  selectedFiles: Set<string>;
  isRunning: boolean;
  runtimeEvents: string[];
  approvals: Approval[];

  /** 追加一条消息并返回其生成的 id（供后续 appendDelta 寻址）。 */
  appendMessage: (role: Role, text: string) => string;
  /** 按 id 把 delta 追加到对应消息文本末尾（流式渲染助手气泡）；id 不存在时为无操作。 */
  appendDelta: (id: string, delta: string) => void;
  /** 设置当前会话 id。 */
  setSession: (sessionId: string) => void;
  /** 切换文件选中态：已选则移除、未选则加入，并新建 Set 引用。 */
  toggleFile: (path: string) => void;
  /** 设置运行中标志。 */
  setRunning: (isRunning: boolean) => void;
  /** 追加一条运行时事件字符串（append 语义：最旧在前、最新在后）。 */
  pushRuntime: (text: string) => void;
  /** 追加一条待审批项。 */
  pushApproval: (approval: Approval) => void;
  /** 浅合并设置（mode/model/providerId/reasoning），未提供字段保持不变。 */
  setSettings: (partial: Partial<Settings>) => void;
  /** 重置运行态（messages/sessionId/runtimeEvents/approvals/selectedFiles/isRunning），保留 settings。 */
  reset: () => void;
}

// 模块内自增计数器：生成确定性、可测试的消息 id，避免 Math.random/Date.now 在测试中碰撞。
let seq = 0;
const nextId = (): string => `m${++seq}`;

// 运行态的初始值（不含 settings）。reset 时复用此对象的拷贝以保持 settings。
const initialRuntime = {
  messages: [] as ChatMessage[],
  sessionId: "",
  selectedFiles: new Set<string>(),
  isRunning: false,
  runtimeEvents: [] as string[],
  approvals: [] as Approval[],
};

// settings 的默认值。
const defaultSettings: Settings = {
  mode: "act",
  model: "",
  providerId: "",
  reasoning: "medium",
};

/**
 * 全局聊天 store。
 * 通过 useChatStore.getState() 在组件外访问状态与 action；
 * 在组件内可用 useChatStore(selector) 进行细粒度订阅。
 */
export const useChatStore = create<ChatState>((set) => ({
  ...initialRuntime,
  ...defaultSettings,

  appendMessage: (role, text) => {
    const id = nextId();
    set((state) => ({ messages: [...state.messages, { id, role, text }] }));
    return id;
  },

  appendDelta: (id, delta) =>
    set((state) => ({
      // 仅替换命中 id 的那条消息；未命中则原样返回（无操作）。
      messages: state.messages.map((m) =>
        m.id === id ? { ...m, text: m.text + delta } : m,
      ),
    })),

  setSession: (sessionId) => set({ sessionId }),

  toggleFile: (path) =>
    set((state) => {
      // 始终基于旧 Set 新建一个，保证引用变化触发订阅者重渲染。
      const next = new Set(state.selectedFiles);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { selectedFiles: next };
    }),

  setRunning: (isRunning) => set({ isRunning }),

  pushRuntime: (text) =>
    set((state) => ({ runtimeEvents: [...state.runtimeEvents, text] })),

  pushApproval: (approval) =>
    set((state) => ({ approvals: [...state.approvals, approval] })),

  setSettings: (partial) => set(() => ({ ...partial })),

  reset: () =>
    set({
      messages: [],
      sessionId: "",
      selectedFiles: new Set<string>(),
      isRunning: false,
      runtimeEvents: [],
      approvals: [],
    }),
}));
