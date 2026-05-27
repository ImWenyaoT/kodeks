export type UiLanguage = "zh" | "en";
export type UiTheme = "light" | "dark";
export type UiLanguagePreference = "system" | UiLanguage;
export type UiThemePreference = "system" | UiTheme;
type UiPreferenceStorage = Pick<Storage, "getItem" | "setItem">;

export const defaultUiLanguagePreference: UiLanguagePreference = "system";
export const defaultUiThemePreference: UiThemePreference = "system";

export type UiCopy = {
  app: {
    welcome: string;
    mobileToolsOpen: string;
    mobileToolsClose: string;
    runtimeFailed: (message: string) => string;
    requestFailed: string;
  };
  chat: {
    composerPlaceholder: string;
    stop: string;
  };
  tools: {
    preferences: string;
    language: string;
    theme: string;
    system: string;
    light: string;
    dark: string;
    fileSearch: string;
    fileSearchDescription: string;
    session: string;
    autoSession: string;
    webSearch: string;
    webSearchDescription: string;
    braveProvider: string;
    userLocation: string;
    clear: string;
    country: string;
    region: string;
    city: string;
    disabledForLocal: string;
    workspaceOnly: string;
    notConfigured: string;
    codeInterpreter: string;
    act: string;
    plan: string;
    functions: string;
    mcp: string;
    mcpDescription: string;
    mcpManifest: string;
    skills: string;
    skillsDescription: string;
    skillSource: string;
    runtimeSettings: string;
    reasoning: string;
    runtimeEvents: string;
    googleIntegration: string;
    connectGoogle: string;
    reasoningOptions: Record<"low" | "medium" | "high" | "xhigh", string>;
  };
  runtime: {
    memoryRecalled: string;
    zeroMemories: string;
    planCreated: string;
    planRecovered: string;
    planDetail: (title: string, stepCount: number) => string;
    subagentStarted: (agent: string) => string;
    subagentCompleted: (agent: string) => string;
    responseCompleted: string;
    status: string;
  };
  toolCall: {
    approvalNeeded: (name: string) => string;
    called: (name: string) => string;
    calling: (name: string) => string;
    waitingForResult: string;
  };
  approval: {
    request: (id: string) => string;
    approve: string;
    decline: string;
  };
};

export const uiCopy: Record<UiLanguage, UiCopy> = {
  zh: {
    app: {
      welcome: "你好，我是 Kodeks。把要处理的代码上下文发给我吧。",
      mobileToolsOpen: "打开工具面板",
      mobileToolsClose: "关闭工具面板",
      runtimeFailed: (message) => `运行失败：${message}`,
      requestFailed: "请求失败。请确认本地 Next.js runtime 仍在运行。"
    },
    chat: {
      composerPlaceholder: "给 Kodeks 发送消息...",
      stop: "停止"
    },
    tools: {
      preferences: "界面",
      language: "语言",
      theme: "主题",
      system: "跟随系统",
      light: "浅色",
      dark: "深色",
      fileSearch: "文件搜索",
      fileSearchDescription: "使用本地 workspace 文件搜索，并通过 Kodeks 工具执行 grep。",
      session: "会话",
      autoSession: "自动会话",
      webSearch: "网页搜索",
      webSearchDescription: "通过 Brave Search API 执行实时网页搜索；配置 BRAVE_SEARCH_API_KEY 后模型可调用 web_search。",
      braveProvider: "Brave Search",
      userLocation: "用户位置",
      clear: "清除",
      country: "国家",
      region: "区域",
      city: "城市",
      disabledForLocal: "本地 Kodeks 已禁用",
      workspaceOnly: "仅 workspace",
      notConfigured: "未配置",
      codeInterpreter: "代码解释器",
      act: "执行",
      plan: "计划",
      functions: "函数",
      mcp: "MCP",
      mcpDescription: "读取 KODEKS_MCP_SERVERS / KODEKS_MCP_SERVER_URL 中的 MCP server manifest，作为后续 MCP tool 调用的入口。",
      mcpManifest: "环境 manifest",
      skills: "Skills",
      skillsDescription: "从 KODEKS_SKILLS_PATHS 或 workspace .kodeks/skills 发现技能，并允许模型读取 SKILL.md。",
      skillSource: "技能目录",
      runtimeSettings: "运行设置",
      reasoning: "推理强度",
      runtimeEvents: "运行事件",
      googleIntegration: "Google 集成",
      connectGoogle: "连接 Google 集成",
      reasoningOptions: {
        low: "低",
        medium: "中",
        high: "高",
        xhigh: "极高"
      }
    },
    runtime: {
      memoryRecalled: "已召回记忆",
      zeroMemories: "0 条记忆",
      planCreated: "计划已保存",
      planRecovered: "已恢复计划",
      planDetail: (title, stepCount) => `${title} · ${stepCount} 步`,
      subagentStarted: (agent) => `子代理 ${agent} 已启动`,
      subagentCompleted: (agent) => `子代理 ${agent} 已完成`,
      responseCompleted: "响应完成",
      status: "状态"
    },
    toolCall: {
      approvalNeeded: (name) => `${name} 需要审批`,
      called: (name) => `已调用 ${name}`,
      calling: (name) => `正在调用 ${name}...`,
      waitingForResult: "等待结果..."
    },
    approval: {
      request: (id) => `Kodeks 请求批准工具调用 ${id}。`,
      approve: "批准",
      decline: "拒绝"
    }
  },
  en: {
    app: {
      welcome: "Hi, I am Kodeks. Send me the code context you want handled.",
      mobileToolsOpen: "Open tools panel",
      mobileToolsClose: "Close tools panel",
      runtimeFailed: (message) => `Runtime failed: ${message}`,
      requestFailed: "Request failed. Confirm the local Next.js runtime is still running."
    },
    chat: {
      composerPlaceholder: "Message Kodeks...",
      stop: "Stop"
    },
    tools: {
      preferences: "Interface",
      language: "Language",
      theme: "Theme",
      system: "System",
      light: "Light",
      dark: "Dark",
      fileSearch: "File Search",
      fileSearchDescription: "Use local workspace file search and grep through Kodeks tools.",
      session: "Session",
      autoSession: "auto session",
      webSearch: "Web Search",
      webSearchDescription: "Run live web search through the Brave Search API. Configure BRAVE_SEARCH_API_KEY to enable the web_search tool.",
      braveProvider: "Brave Search",
      userLocation: "User's location",
      clear: "Clear",
      country: "Country",
      region: "Region",
      city: "City",
      disabledForLocal: "Disabled for local Kodeks",
      workspaceOnly: "Workspace only",
      notConfigured: "Not configured",
      codeInterpreter: "Code Interpreter",
      act: "Act",
      plan: "Plan",
      functions: "Functions",
      mcp: "MCP",
      mcpDescription: "Reads MCP server manifests from KODEKS_MCP_SERVERS / KODEKS_MCP_SERVER_URL as the entry point for future MCP tool calls.",
      mcpManifest: "Env manifest",
      skills: "Skills",
      skillsDescription: "Discovers skills from KODEKS_SKILLS_PATHS or workspace .kodeks/skills and lets the model read SKILL.md.",
      skillSource: "Skill roots",
      runtimeSettings: "Runtime",
      reasoning: "Reasoning",
      runtimeEvents: "Runtime events",
      googleIntegration: "Google Integration",
      connectGoogle: "Connect Google Integration",
      reasoningOptions: {
        low: "Low",
        medium: "Medium",
        high: "High",
        xhigh: "X-high"
      }
    },
    runtime: {
      memoryRecalled: "Memory recalled",
      zeroMemories: "0 memories",
      planCreated: "Plan saved",
      planRecovered: "Plan recovered",
      planDetail: (title, stepCount) => `${title} · ${stepCount} steps`,
      subagentStarted: (agent) => `Subagent ${agent} started`,
      subagentCompleted: (agent) => `Subagent ${agent} completed`,
      responseCompleted: "Response completed",
      status: "Status"
    },
    toolCall: {
      approvalNeeded: (name) => `Approval needed for ${name}`,
      called: (name) => `Called ${name}`,
      calling: (name) => `Calling ${name}...`,
      waitingForResult: "Waiting for result..."
    },
    approval: {
      request: (id) => `Kodeks requests approval for tool call ${id}.`,
      approve: "Approve",
      decline: "Decline"
    }
  }
};

// 判断一个外部字符串是否是界面支持的语言偏好。
export function isUiLanguagePreference(value: string | null): value is UiLanguagePreference {
  return value === "system" || value === "zh" || value === "en";
}

// 判断一个外部字符串是否是界面支持的主题偏好。
export function isUiThemePreference(value: string | null): value is UiThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

// 把 localStorage 或 URL 中的语言偏好解析成可发布的默认值。
export function parseUiLanguagePreference(value: string | null): UiLanguagePreference {
  return isUiLanguagePreference(value) ? value : defaultUiLanguagePreference;
}

// 把 localStorage 或 URL 中的主题偏好解析成可发布的默认值。
export function parseUiThemePreference(value: string | null): UiThemePreference {
  return isUiThemePreference(value) ? value : defaultUiThemePreference;
}

// 在 system 模式下使用浏览器推断值，否则使用用户显式选择。
export function resolveUiLanguage(preference: UiLanguagePreference, systemLanguage: UiLanguage): UiLanguage {
  return preference === "system" ? systemLanguage : preference;
}

// 在 system 模式下使用系统深浅色，否则使用用户显式选择。
export function resolveUiTheme(preference: UiThemePreference, systemTheme: UiTheme): UiTheme {
  return preference === "system" ? systemTheme : preference;
}

// 从本地存储读取语言偏好，遇到不可用或脏数据时回到 system。
export function readUiLanguagePreference(storage: UiPreferenceStorage, key: string): UiLanguagePreference {
  try {
    return parseUiLanguagePreference(storage.getItem(key));
  } catch {
    return defaultUiLanguagePreference;
  }
}

// 从本地存储读取主题偏好，遇到不可用或脏数据时回到 system。
export function readUiThemePreference(storage: UiPreferenceStorage, key: string): UiThemePreference {
  try {
    return parseUiThemePreference(storage.getItem(key));
  } catch {
    return defaultUiThemePreference;
  }
}

// 保存用户 UI 偏好；浏览器拒绝写入时不打断当前会话。
export function writeUiPreference(storage: UiPreferenceStorage, key: string, value: UiLanguagePreference | UiThemePreference): boolean {
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

const localizedWelcomeMessages = new Set([uiCopy.zh.app.welcome, uiCopy.en.app.welcome]);
const localizedRequestFailures = new Set([uiCopy.zh.app.requestFailed, uiCopy.en.app.requestFailed]);
const runtimeFailurePrefixes = ["运行失败：", "Runtime failed: "] as const;

// 把框架级欢迎语和错误提示重新投影到当前语言，保留真实模型输出不变。
export function localizeAssistantMessageContent(content: string, copy: UiCopy): string {
  if (localizedWelcomeMessages.has(content)) {
    return copy.app.welcome;
  }

  if (localizedRequestFailures.has(content)) {
    return copy.app.requestFailed;
  }

  const runtimeFailureMessage = getRuntimeFailureMessage(content);
  return runtimeFailureMessage === null ? content : copy.app.runtimeFailed(runtimeFailureMessage);
}

// 识别中英文 runtime 错误前缀，并抽出后端原始错误内容。
function getRuntimeFailureMessage(content: string): string | null {
  for (const prefix of runtimeFailurePrefixes) {
    if (content.startsWith(prefix)) {
      return content.slice(prefix.length);
    }
  }
  return null;
}
