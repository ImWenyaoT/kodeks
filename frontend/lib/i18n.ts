// frontend/lib/i18n.ts
// 国际化文案字典：从既有 index.html 的 `copy` 对象逐字移植（zh/en）。
// 保持 zh 与 en 键集合完全一致；通过 `Copy` 类型让 TypeScript 强制 parity。

/** 支持的界面语言。 */
export type Language = "zh" | "en";

/**
 * 单语言文案的结构契约。
 * 同时被 zh 与 en 复用，TS 借此强制两套字典拥有相同的键。
 */
export type Copy = {
  welcome: string;
  newSession: string;
  recentSessions: string;
  noSessions: string;
  loadingSessions: string;
  sessionLoadError: string;
  fileSearch: string;
  fileDescription: string;
  selectFiles: string;
  noFilesSelected: string;
  /** 已选择文件数量的格式化文案。 */
  selectedFileCount: (count: number) => string;
  filePlaceholder: string;
  noFileMatches: string;
  composer: string;
  send: string;
  stop: string;
  debug: string;
  appearance: string;
  runtime: string;
  bridge: string;
  approvals: string;
  activity: string;
  mode: string;
  act: string;
  plan: string;
  provider: string;
  model: string;
  reasoning: string;
  light: string;
  dark: string;
  system: string;
  zh: string;
  en: string;
  ready: string;
  checking: string;
  unavailable: string;
  notRequired: string;
  bridgeMessage: string;
  session: string;
  autoSession: string;
  runtimeEvents: string;
  notConfigured: string;
  requestFailed: string;
  /** 运行失败的格式化文案。 */
  runtimeFailed: (message: string) => string;
  /** 推理强度选项标签。 */
  reasoningOptions: { low: string; medium: string; high: string; xhigh: string };
};

/**
 * 中英文文案字典。
 * `Record<Language, Copy>` 确保 zh 与 en 都满足同一结构契约。
 */
export const copy: Record<Language, Copy> = {
  zh: {
    welcome: "你好，我是 Kodeks。把要处理的代码上下文发给我吧。",
    newSession: "新会话",
    recentSessions: "最近会话",
    noSessions: "暂无历史会话",
    loadingSessions: "正在读取会话...",
    sessionLoadError: "会话列表读取失败",
    fileSearch: "文件搜索",
    fileDescription: "使用本地 workspace 文件作为会话上下文。",
    selectFiles: "选择文件",
    noFilesSelected: "尚未选择文件",
    selectedFileCount: (count) => `已选择 ${count} 个文件`,
    filePlaceholder: "搜索 workspace 文件...",
    noFileMatches: "没有匹配的文件",
    composer: "给 Kodeks 发送消息...",
    send: "发送消息",
    stop: "停止",
    debug: "调试",
    appearance: "外观",
    runtime: "运行设置",
    bridge: "MoonBridge",
    approvals: "审批",
    activity: "运行事件",
    mode: "代码解释器",
    act: "执行",
    plan: "计划",
    provider: "模型服务",
    model: "模型",
    reasoning: "推理强度",
    light: "浅色",
    dark: "深色",
    system: "设备",
    zh: "中文",
    en: "EN",
    ready: "Bridge 已就绪",
    checking: "正在预检",
    unavailable: "Bridge 不可用",
    notRequired: "无需 Bridge",
    bridgeMessage: "正在确认当前 provider 的状态...",
    session: "会话",
    autoSession: "自动会话",
    runtimeEvents: "运行事件",
    notConfigured: "未配置",
    requestFailed: "请求失败。请确认本地 Python runtime 仍在运行。",
    runtimeFailed: (message) => `运行失败：${message}`,
    reasoningOptions: { low: "低", medium: "中", high: "高", xhigh: "极高" },
  },
  en: {
    welcome: "Hi, I am Kodeks. Send me the code context you want handled.",
    newSession: "New session",
    recentSessions: "Recent sessions",
    noSessions: "No session history yet",
    loadingSessions: "Loading sessions...",
    sessionLoadError: "Failed to load sessions",
    fileSearch: "File Search",
    fileDescription: "Use local workspace files as chat context.",
    selectFiles: "Select files",
    noFilesSelected: "No files selected",
    selectedFileCount: (count) => `${count} file${count === 1 ? "" : "s"} selected`,
    filePlaceholder: "Search workspace files...",
    noFileMatches: "No matching files",
    composer: "Message Kodeks...",
    send: "Send message",
    stop: "Stop",
    debug: "Debug",
    appearance: "Appearance",
    runtime: "Runtime",
    bridge: "MoonBridge",
    approvals: "Approvals",
    activity: "Runtime events",
    mode: "Code Interpreter",
    act: "Act",
    plan: "Plan",
    provider: "Provider",
    model: "Model",
    reasoning: "Reasoning",
    light: "Light",
    dark: "Dark",
    system: "Device",
    zh: "中文",
    en: "EN",
    ready: "Bridge ready",
    checking: "Checking",
    unavailable: "Bridge unavailable",
    notRequired: "Bridge not needed",
    bridgeMessage: "Checking the current provider status...",
    session: "Session",
    autoSession: "auto session",
    runtimeEvents: "Runtime events",
    notConfigured: "Not configured",
    requestFailed: "Request failed. Confirm the local Python runtime is still running.",
    runtimeFailed: (message) => `Runtime failed: ${message}`,
    reasoningOptions: { low: "Low", medium: "Medium", high: "High", xhigh: "X-high" },
  },
};

/**
 * 将浏览器/系统语言标签解析为受支持的界面语言。
 * 标签（大小写不敏感）以 "zh" 开头时返回 "zh"，否则回退到 "en"。
 */
export function resolveLanguage(tag: string): Language {
  return tag.toLowerCase().startsWith("zh") ? "zh" : "en";
}
