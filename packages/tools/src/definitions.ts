export type JsonSchemaProperty = {
  type?: string | string[];
  description?: string;
  enum?: string[];
  properties?: Record<string, JsonSchemaProperty>;
  items?: JsonSchemaProperty;
};

export type ToolParametersSchema = {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
};

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: ToolParametersSchema;
};

// Defines the read_file tool schema exposed to the model.
function readFileDefinition(): ToolDefinition {
  return {
    name: "read_file",
    description: "Read a UTF-8 text file from the authorized workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
  };
}

// Defines the write_file tool schema exposed to the model.
function writeFileDefinition(): ToolDefinition {
  return {
    name: "write_file",
    description:
      "Write UTF-8 text to a workspace file using whole-file overwrite semantics.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  };
}

// Defines the grep tool schema exposed to the model.
function grepDefinition(): ToolDefinition {
  return {
    name: "grep",
    description: "Search visible workspace text files for a literal query.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["query"],
    },
  };
}

// Defines the run_shell tool schema exposed to the model.
function runShellDefinition(): ToolDefinition {
  return {
    name: "run_shell",
    description:
      "Run a safe command in the workspace or request approval for dangerous commands.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
      },
      required: ["command"],
    },
  };
}

// Defines the remember_fact tool schema exposed to the model.
function rememberFactDefinition(): ToolDefinition {
  return {
    name: "remember_fact",
    description: "Save one explicit memory fact.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string" },
        scope: { type: "string" },
      },
      required: ["content"],
    },
  };
}

// Defines the recall_memory tool schema exposed to the model.
function recallMemoryDefinition(): ToolDefinition {
  return {
    name: "recall_memory",
    description:
      "Recall relevant layered memory facts, scenarios, and artifact refs.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer" },
        layers: {
          type: "array",
          items: { type: "string", enum: ["atom", "scenario", "artifact"] },
        },
      },
      required: ["query"],
    },
  };
}

// Defines the read_memory_artifact tool schema for offloaded large tool outputs.
function readMemoryArtifactDefinition(): ToolDefinition {
  return {
    name: "read_memory_artifact",
    description: "Read a large offloaded memory artifact by refId.",
    parameters: {
      type: "object",
      properties: {
        refId: { type: "string" },
      },
      required: ["refId"],
    },
  };
}

// Defines the spawn_explore_agent tool schema exposed to the model.
function spawnExploreAgentDefinition(): ToolDefinition {
  return {
    name: "spawn_explore_agent",
    description:
      "Run one read-only explore subagent task and return its compact summary.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string" },
      },
      required: ["task"],
    },
  };
}

// Defines a read-only MCP manifest inspection tool.
function listMcpServersDefinition(): ToolDefinition {
  return {
    name: "list_mcp_servers",
    description:
      "List configured MCP server manifests from KODEKS_MCP_SERVERS or KODEKS_MCP_SERVER_URL.",
    parameters: {
      type: "object",
      properties: {},
    },
  };
}

// Defines a read-only skills discovery tool.
function listSkillsDefinition(): ToolDefinition {
  return {
    name: "list_skills",
    description:
      "List available Kodeks skills from KODEKS_SKILLS_PATHS or the workspace .kodeks/skills directory.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer" },
      },
    },
  };
}

// Defines a read-only skill body lookup tool.
function readSkillDefinition(): ToolDefinition {
  return {
    name: "read_skill",
    description: "Read one available skill's SKILL.md by name.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    },
  };
}

export const defaultToolDefinitions = [
  readFileDefinition(),
  writeFileDefinition(),
  grepDefinition(),
  runShellDefinition(),
  rememberFactDefinition(),
  recallMemoryDefinition(),
  readMemoryArtifactDefinition(),
  spawnExploreAgentDefinition(),
  listMcpServersDefinition(),
  listSkillsDefinition(),
  readSkillDefinition(),
] as const satisfies readonly ToolDefinition[];
