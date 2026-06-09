// frontend/lib/server/tools/schemas.ts
// 9 个 model-facing 工具的 JSON schema：逐字移植 Python src/kodeks/tools/schemas.py。
// name/description/parameters/required 全部逐字；注册与 default 顺序一致。
//
// 保真红线（见 50-tools-security.md §1/§3、保真风险 7）：
//  · 9 个工具顺序固定：read_file,write_file,grep,run_shell,remember_fact,recall_memory,
//    read_memory_artifact,spawn_explore_agent,list_mcp_servers。
//  · run_shell description 是多行拼接（逐字）；list_mcp_servers properties 为空对象、无 required。
//  · read_only_only=true 仅保留 read_only_names 集合（裁掉 write_file/run_shell/remember_fact）。
//  · JSON schema 用纯对象字面量表达（不引入 zod-to-json-schema 依赖），逐字对齐 Python dict。
import type { ToolDefinition } from './types'

/**
 * 返回 model-facing 工具 schema，顺序与 registry 一致（移植 default_tool_definitions，schemas.py:26-141）。
 * read_only_only=true 时仅保留 read_only_names 集合（plan-mode 子集，裁掉 3 个 mutating 工具）。
 * @param readOnlyOnly 是否仅返回只读子集（plan-mode）。
 */
export function defaultToolDefinitions(readOnlyOnly = false): ToolDefinition[] {
  const definitions: ToolDefinition[] = [
    {
      name: 'read_file',
      description: 'Read a UTF-8 text file from the authorized workspace.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
    {
      name: 'write_file',
      description: 'Write UTF-8 text to a workspace file using whole-file overwrite semantics.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'grep',
      description: 'Search visible workspace text files for a literal query.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer' },
        },
        required: ['query'],
      },
    },
    {
      name: 'run_shell',
      // 多行拼接，逐字对齐 Python（schemas.py:65-69）。
      description:
        'Run one workspace command as plain argv without a shell. Do not use ' +
        'pipes, redirects, variables, command substitution, semicolons, or ' +
        'control operators; dangerous commands request approval.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
    {
      name: 'remember_fact',
      description: 'Save one explicit memory fact.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          scope: { type: 'string' },
        },
        required: ['content'],
      },
    },
    {
      name: 'recall_memory',
      description: 'Recall relevant memory facts and artifact refs.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer' },
          layers: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['atom', 'artifact'],
            },
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'read_memory_artifact',
      description: 'Read a large offloaded memory artifact by refId.',
      parameters: {
        type: 'object',
        properties: { refId: { type: 'string' } },
        required: ['refId'],
      },
    },
    {
      name: 'spawn_explore_agent',
      description:
        'Run one quarantined read-only explore subagent task and return claim/evidence/risk/confidence/nextAction.',
      parameters: {
        type: 'object',
        properties: { task: { type: 'string' } },
        required: ['task'],
      },
    },
    {
      name: 'list_mcp_servers',
      description:
        'List configured MCP server manifests from KODEKS_MCP_SERVERS or KODEKS_MCP_SERVER_URL.',
      parameters: { type: 'object', properties: {} },
    },
  ]
  if (!readOnlyOnly) {
    return definitions
  }
  const readOnlyNames = new Set([
    'read_file',
    'grep',
    'recall_memory',
    'read_memory_artifact',
    'spawn_explore_agent',
    'list_mcp_servers',
  ])
  return definitions.filter((definition) => readOnlyNames.has(definition.name))
}

/** 返回按公共工具名索引的默认 schema（移植 tool_definitions_by_name，schemas.py:144-147）。 */
export function toolDefinitionsByName(): Record<string, ToolDefinition> {
  const byName: Record<string, ToolDefinition> = {}
  for (const definition of defaultToolDefinitions()) {
    byName[definition.name] = definition
  }
  return byName
}
