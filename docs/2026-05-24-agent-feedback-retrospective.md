# Agent Feedback Retrospective: 2026-05-24

## Goal

这份记录整理了 `kodeks` 从“最小聊天界面”走向“可解释 coding agent demo”过程中暴露的一批真实问题。它不是发布日志，而是面试复盘材料：每个问题都按现象、根因、修复、验证和可讲点整理，方便后续解释自己如何把一个 demo 打磨成更接近真实产品的 agent harness。

## Summary

本轮反馈集中在三类问题：

- 前端 UX：响应式布局、导航交互、信息密度、滚动区域边界。
- Model/runtime wiring：模型配置加载、stream error 可见性、tool call 协议。
- Agent harness contract：思考过程泄漏、默认英文回复、URL 工具能力边界。

这些问题的共同点是：它们表面上像 UI bug 或模型偶发问题，但根因大多在 harness contract 和产品边界上。coding agent 项目不能只把 LLM 接上去，还要负责上下文组装、工具协议、权限恢复、错误展示和可观察性。

## Issue 1: composer 在窄尺寸下溢出

### Symptom

在较窄视口或卡片宽度下，输入框底部的 `Send` 按钮会跑出 composer 边界。用户期望按钮随着空间变小逐步收缩，最后只保留发送图标。

### Root Cause

composer 底部控件被当作固定宽度按钮组处理，`Send` 文案和图标始终占用完整宽度；当 mode segmented control、model selector、send button 同时存在时，容器没有基于自身宽度做响应式降级。

### Fix

- 给 composer 添加 container query，让按钮响应的是输入组件自身宽度，而不是整页 viewport。
- `Send` 文案单独包进 `.send-label`，窄容器下隐藏文字，只保留图标。
- 收紧 mode control、model selector 和按钮尺寸，保证控件不会把布局撑出边界。
- 给发送按钮补 `aria-label`，避免隐藏文字后丢失可访问名称。

### Verification

- `bun --filter @kodeks/web typecheck`
- `bun --filter @kodeks/web lint`
- `bun --filter @kodeks/web test`
- 浏览器检查窄布局下 `sendOverflowsComposer=false`

### Interview Angle

这个问题可以说明：响应式设计不只是写几个 viewport media query。对嵌套聊天 composer 这种组件，更稳的是用 container query，让组件根据自己的可用空间做降级；同时要保证视觉收缩不牺牲 accessibility。

## Issue 2: sidebar 导航有样式但没有真实交互

### Symptom

左侧 `Today`、`Chat`、`Tools`、`Runtime` 看起来是可点击导航，但点击后没有明显反馈，用户会觉得“设计了按钮但没做功能”。

### Root Cause

导航只是静态 anchor/hash，没有把当前 section 状态同步到 UI，也没有对应的 focus 或 scroll 行为。视觉上像完整 app shell，行为上仍是静态 demo。

### Fix

- 增加 `activeSection` state，同步 `window.location.hash`。
- 点击 sidebar 项时更新 active state、替换 URL hash，并滚动到对应 section。
- 点击 `Chat` 时自动 focus message textarea。
- active link 使用真实状态驱动，而不是只靠静态样式。

### Verification

- 浏览器手动验证点击导航后 active state、hash、focus 行为都生效。
- 保持 typecheck、lint、test 通过。

### Interview Angle

这个问题适合讲“产品完整性”。如果一个元素看起来可交互，就应该有明确反馈；否则宁愿先不要做出来。demo 里最伤信任感的不是功能少，而是 affordance 和行为不一致。

## Issue 3: 对话多了以后整页滚动，而不是 conversation 内部滚动

### Symptom

聊天记录变长后，整个页面开始滚动，header、sidebar、右侧 session/event panel 都跟着移动。用户期望像 ChatGPT/Codex 一样，主窗口固定，只有对话列表滚动。

### Root Cause

页面外层没有建立固定高度的 app shell。`message-list` 虽然像对话容器，但不是唯一 scroll owner；内容增长时高度继续向外撑开，最终让 document body 成为滚动容器。

### Fix

- `html`、`body` 和 app shell 使用固定视口高度，并隐藏外层 overflow。
- 主内容区域使用 `min-height: 0` 和 flex/grid 约束，避免子元素把父级撑开。
- `.message-list` 设置为内部滚动容器。
- 右侧 activity stack 独立滚动。
- 移动端在小屏 media query 下恢复页面滚动，避免固定高度伤害移动体验。

### Verification

浏览器测量结果：

- `document.scrollHeight === document.clientHeight`
- `html/body overflow-y` 为 `hidden`
- `.message-list overflow-y` 为 `auto`
- `.today-stack overflow-y` 为 `auto`

同时运行：

- `bun --filter @kodeks/web typecheck`
- `bun --filter @kodeks/web lint`
- `bun --filter @kodeks/web test`

### Interview Angle

这个问题能讲清楚复杂前端布局里的 scroll ownership。真实工作台类产品通常需要固定 shell，把滚动权交给特定 pane；关键细节是 `min-height: 0`，否则 flex/grid 子元素仍会把外层撑开。

## Issue 4: 发 `hi` 没反应

### Symptom

用户发送 `hi` 后，前端没有正常显示模型回复。看起来像模型没配置，或者 stream 卡住。

### Root Cause

有两个问题叠加：

- runtime 只识别 `OPENAI_API_KEY`，但本地 `.env` 已配置的是 DeepSeek/Ark 兼容变量。
- stream error 只进入右侧 event log，聊天气泡里仍停留在占位状态，用户体感就是“没反应”。

### Fix

- 在 Next runtime 中加载 workspace root `.env`。
- 新增 model client option resolution，按优先级支持 OpenAI、DeepSeek、Ark。
- 没有 key 时返回明确错误：需要设置 `OPENAI_API_KEY`、`DEEPSEEK_API_KEY` 或 `ARK_API_KEY`。
- 前端收到 stream error 时，把错误写入当前 assistant bubble，避免错误只藏在 event log。

### Verification

- `bun --filter @kodeks/web typecheck`
- `bun --filter @kodeks/web lint`
- `bun --filter @kodeks/web test`
- 直接请求 `/api/chat/stream` 发送 `hi`，确认可以流式返回模型内容。

### Interview Angle

这可以讲“配置兼容性”和“错误可见性”。模型没接通不是一个单点 bug，而是 provider abstraction、env loading 和 UI error channel 没有打通。面试里可以强调：用户看到的是“没反应”，工程上要拆成配置解析、服务端错误、前端呈现三层。

## Issue 5: LeetCode URL 触发 orphan tool message 400

### Symptom

发送 LeetCode Two Sum 链接后，runtime 报错：

```text
400 Messages with role 'tool' must be a response to a preceding message with 'tool_calls'
```

右侧 event log 还出现 approval 相关事件，让问题看起来像审批流或 LeetCode URL 导致。

### Root Cause

这是 agent runtime 的 Chat Completions 协议拼装错误。模型发出 tool call 后，下一轮请求不能只追加 `role: "tool"` 的结果消息；必须先保留上一轮 assistant 的 `tool_calls` envelope，再接对应的 tool result。

错误链路是：

```text
assistant tool_call
tool result
next model request only contains role="tool"
provider rejects orphan tool message
```

另外，当 `run_shell` 返回 `approval_required` 时，runtime 还继续进入下一轮模型请求，也会制造 orphan tool message 风险。approval_required 应该暂停 agent turn，等待人类决策。

### Fix

- `ChatMessage` 增加 `toolCalls` 字段。
- model adapter 把 assistant tool calls 转成 OpenAI-compatible `tool_calls`。
- runtime 记录本轮 tool calls，在下一轮 messages 中插入 assistant tool-call envelope。
- 如果工具结果是 `approval_required`，停止继续请求模型，只发 approval event，让 UI/用户处理。
- 加测试覆盖：
  - tool call 后下一轮请求包含 assistant `toolCalls`。
  - approval-required tool result 会暂停，不继续发送第二轮模型请求。
  - model adapter 正确生成 Chat Completions `tool_calls` 消息。

### Verification

- `bun --filter @kodeks/agent-runtime test`
- `bun --filter @kodeks/agent-runtime typecheck`
- `bun --filter @kodeks/model test`
- `bun --filter @kodeks/model typecheck`
- `bun --filter @kodeks/web test`
- `bun --workspaces run typecheck`
- `bun --workspaces run test`
- `bun --workspaces run lint`
- 用同一个 LeetCode URL 重新请求 `/api/chat/stream`，不再出现 400；runtime 在需要 shell approval 时正确停在 `approval_required`。

### Interview Angle

这是最适合讲 agent harness 的案例：LLM tool calling 不是“模型想调工具，我执行一下”这么简单。runtime 必须维护 provider 协议要求的 message shape，尤其是 assistant `tool_calls` 和 tool result 的配对关系。这个问题也能延伸到 approval pause/resume 的状态机设计。

## Issue 6: approval 重复处理返回 HTTP 409

### Symptom

右侧 event log 中出现：

```text
Approval error HTTP 409
```

### Root Cause

同一个 approval 被重复 approve。后端把 approval 设计成一次性消费：pending 可以被 approved/rejected，已经处理过的 approval 再次处理会返回 conflict。

### Fix

这不是协议 bug，而是后端安全语义。需要在 UI 上把 approval 的 terminal state 表达清楚，避免用户重复点击；后端继续保留 409，防止危险命令被重复执行。

### Verification

- approval service tests 覆盖重复 approve/reject 返回 conflict。
- 事件流里可以看到 approval 已处理后不会再次执行命令。

### Interview Angle

这个点可以讲 permission system 的安全边界。对 coding agent 来说，审批不是普通按钮状态，而是一个可审计、一次性消费的授权 token。409 是合理保护，下一步产品化重点是让 UI 更清楚地表达状态。

## Issue 7: 模型把“思考过程”或自言自语输出到聊天框

### Symptom

模型回复中出现类似：

```text
Let me first explore the problem...
The user is sharing a LeetCode problem link...
```

这类内容像内部推理、行动计划或 harness 自言自语，被直接展示给用户。

### Root Cause

这更偏 harness 内因，而不是单纯 LLM 外因。当前 system prompt 过薄，只告诉模型它是 Kodeks Build Agent，没有明确约束：

- 默认使用中文。
- 不输出内部推理或自言自语。
- 工具调用前的状态文本应该进入 activity/status，而不是最终 chat answer。
- 没有网页读取工具时，不要暗示自己已经访问了 URL。

同时 runtime 把所有 `text_delta` 原样流进 assistant bubble，没有区分 visible answer、status update 和 tool activity。

### Proposed Fix

短期可以加 prompt contract：

- 默认使用用户语言；用户用中文时默认中文。
- 不展示隐藏推理；只给简洁结论、必要步骤和结果。
- 如果需要使用工具，把工具意图作为 event/status，而不是混进最终回答。
- 对 URL 说明能力边界：没有网页读取工具时不能声称已读取网页。

中期需要 event contract 分层：

- `assistant_status`: 可展示在 activity log 的短状态。
- `text_delta`: 面向用户的最终回答。
- `tool_call` / `tool_result`: 工具活动。

长期可以补受控 `fetch_url` / `read_webpage` tool，让 LeetCode 链接这类任务有真实能力边界。

### Verification Plan

- 给 `buildAgentInstructions()` 加测试，断言包含中文默认、不要泄露内部推理、URL 能力边界。
- 加 stream rendering 测试，确保 tool 前状态文本不会污染最终 assistant answer。
- 用中文输入、英文输入、URL 输入各跑一组 golden cases。

### Interview Angle

这个问题能说明 agent 产品和普通 chatbot 的差异：LLM 输出不是天然等于 UI 文本。成熟 harness 要定义 prompt contract 和 event contract，决定哪些内容进入最终回答，哪些进入 activity log，哪些需要隐藏或结构化。

## Issue 8: 默认回复英文

### Symptom

用户用中文提问，模型仍默认用英文回答。

### Root Cause

system prompt 是英文，且没有用户语言偏好或 locale policy。模型在无约束时会沿系统消息和训练默认风格输出英文。

### Proposed Fix

- system prompt 明确：默认使用用户最近一条消息的语言；如果用户中文提问，回复中文。
- 将用户偏好作为 memory/context 注入，例如“用户偏好中文交流”。
- 对工具结果摘要也做同样语言约束，避免最终回答中文、过程事件英文混杂。

### Verification Plan

- 增加 prompt/unit test。
- 增加中文输入的 integration smoke test。

### Interview Angle

这是一个很小但很真实的产品细节：agent 不只是 API wrapper，还要把用户偏好、项目上下文和语言策略显式编码进 harness。

## Open Follow-Ups

- 前端：把 approval prompt 做成明确的 pending/approved/rejected 状态组件，减少重复点击导致的 409 困惑。
- Runtime：实现 visible output policy，把 status、tool activity、final answer 分开。
- Prompt：收紧 build agent system prompt，加入中文默认、不要泄露内部推理、URL 能力边界。
- Tools：评估是否加入受控网页读取工具，解决 LeetCode/GitHub issue/文档链接这类真实 coding-agent 场景。
- Evaluation：为中文回复、URL 能力边界、tool-call message shape 和 approval pause 建一组 regression cases。

## One-Minute Interview Story

我做 `kodeks` 时，一开始它只是能流式聊天的 demo。用户试用后暴露了几类真实问题：前端在窄尺寸下按钮溢出、聊天记录让整页滚动、左侧导航没有真实行为；模型配置也不够稳，只认 OpenAI key，导致本地 DeepSeek/Ark 配置下看起来像“没反应”。

更有意思的是 agent runtime 问题：用户发 LeetCode 链接后触发了 OpenAI-compatible Chat Completions 的 400，因为我在 tool loop 里只把 `role="tool"` 结果发回模型，却没有保留上一轮 assistant 的 `tool_calls` envelope。这说明 coding agent 的难点不只是执行工具，而是维护严格的 provider message protocol 和 approval 状态机。我修复后补了 runtime/model tests，确保 tool call 和 tool result 成对出现，并且 approval_required 会暂停 agent turn，不继续制造 orphan tool message。

最后还有 harness contract 问题：模型会把 “Let me explore...” 甚至类似内部推理的文本直接流进聊天框，并且默认英文回复。这个根因不是模型“笨”，而是 system prompt 和 event contract 太薄。后续需要把 final answer、status、tool activity 分层，并在 prompt 中明确中文默认和不泄露内部推理。这个过程让我更清楚地认识到：agent 项目的核心不是套一个 LLM API，而是把 UI、runtime、tool protocol、permission、prompt contract 和 evaluation 全部接成可验证的系统。
