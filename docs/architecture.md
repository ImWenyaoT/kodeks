# Kodeks Architecture

Kodeks is a TypeScript full-stack coding agent workbench for internship-level learning and interview storytelling. The target is intentionally narrower than a production agent platform: keep the core coding-agent loop understandable while still covering memory, multi-session, subagent exploration, and plan mode.

## Product Boundary

The required product surface is:

- streaming chat over a project workspace
- multi-session transcript storage and resume
- workspace tools for reading, writing, grep, and shell execution
- approval records for risky shell commands
- memory write, recall, and artifact read tools
- plan mode with mutating tools filtered out
- subagent exploration with auditable summaries
- MCP server and skill discovery
- model routing through OpenAI Responses or MoonBridge

Everything outside that list should earn its place. Web search, duplicate stream protocols, provider dashboards, advanced memory ranking, and large plugin surfaces are deferred until the required loop is small and reliable.

## Runtime Flow

The main request path is:

1. The Next.js UI posts chat input to `/api/chat/stream`.
2. The route parses request state and opens a single SSE stream.
3. `apps/web/src/lib/server/kodeks-runtime.ts` creates the runtime context, model options, storage repositories, and tool services.
4. `packages/agent-runtime` runs the OpenAI Agents SDK path when available, maps model/tool events into Kodeks events, and applies plan-mode filtering.
5. `packages/tools` owns deterministic tool definitions and execution wrappers.
6. `packages/workspace` enforces path and shell policy.
7. `packages/storage` persists sessions, messages, memories, approvals, and subagent records.
8. The UI renders Kodeks SSE events directly.

There is no second UIMessage stream route. If a future UI layer needs a Vercel AI SDK transport, it should be added as one adapter around the same runtime event contract, not as a parallel runtime path.

## Model Boundary

The public provider surface is only:

- `openai`: direct Responses-compatible provider configuration.
- `moonbridge`: local Responses-compatible bridge for Chat Completions providers.

MoonBridge stays because it lets Kodeks keep one Responses-shaped agent runtime while still using DeepSeek, local Qwen, or another Chat Completions endpoint. The old `bridge`, `deepseek`, and `chat-completions` names are accepted only as compatibility aliases and are normalized to `moonbridge` before runtime execution.

`packages/model` should stay small. Its job is resolving model options and creating a Responses-shaped client, not owning a second agent loop.

## Memory Boundary

Memory should be TencentDB-Agent-Memory-inspired, but implemented as a minimum viable layered system instead of a direct port:

- L0: transcript and tool evidence already stored by the runtime.
- L1: atomic facts such as user preferences, project facts, and durable lessons.
- L2: scenario memories that summarize repeated workflows or debugging patterns.
- L3: profile and project-level summaries assembled from stable lower layers.
- Artifacts: large evidence blobs referenced by id instead of copied into every prompt.

Deferred memory work includes embeddings, vector rerank, freshness scoring, dashboards, full graph structures, and automatic large-scale consolidation. Those are useful later, but they are not needed to explain the current coding-agent loop.

## Deliberate Removals

The current simplification removes:

- web search tools and settings
- Brave/Tavily environment configuration
- `/api/chat/ui-stream`
- direct runtime dependency on Vercel AI SDK UIMessage helpers
- user-facing `bridge` provider naming

The remaining stack is easier to explain: one web app, one runtime event contract, one tool registry, one storage boundary, and two model-facing options.
