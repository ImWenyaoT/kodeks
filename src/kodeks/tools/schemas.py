"""Model-facing function tool schemas for Kodeks."""

from __future__ import annotations

from typing import Any

ToolDefinition = dict[str, Any]


def default_tool_definitions(read_only_only: bool = False) -> list[ToolDefinition]:
    """Return model-facing tool schemas in the same order as the registry."""

    definitions = [
        {
            "name": "read_file",
            "description": "Read a UTF-8 text file from the authorized workspace.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        },
        {
            "name": "write_file",
            "description": "Write UTF-8 text to a workspace file using whole-file overwrite semantics.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string"},
                },
                "required": ["path", "content"],
            },
        },
        {
            "name": "grep",
            "description": "Search visible workspace text files for a literal query.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "limit": {"type": "integer"},
                },
                "required": ["query"],
            },
        },
        {
            "name": "run_shell",
            "description": "Run a safe command in the workspace or request approval for dangerous commands.",
            "parameters": {
                "type": "object",
                "properties": {"command": {"type": "string"}},
                "required": ["command"],
            },
        },
        {
            "name": "remember_fact",
            "description": "Save one explicit memory fact.",
            "parameters": {
                "type": "object",
                "properties": {
                    "content": {"type": "string"},
                    "scope": {"type": "string"},
                },
                "required": ["content"],
            },
        },
        {
            "name": "recall_memory",
            "description": "Recall relevant layered memory facts, scenarios, and artifact refs.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "limit": {"type": "integer"},
                    "layers": {
                        "type": "array",
                        "items": {
                            "type": "string",
                            "enum": ["atom", "scenario", "artifact"],
                        },
                    },
                },
                "required": ["query"],
            },
        },
        {
            "name": "read_memory_artifact",
            "description": "Read a large offloaded memory artifact by refId.",
            "parameters": {
                "type": "object",
                "properties": {"refId": {"type": "string"}},
                "required": ["refId"],
            },
        },
        {
            "name": "spawn_explore_agent",
            "description": "Run one read-only explore subagent task and return its compact summary.",
            "parameters": {
                "type": "object",
                "properties": {"task": {"type": "string"}},
                "required": ["task"],
            },
        },
        {
            "name": "list_mcp_servers",
            "description": "List configured MCP server manifests from KODEKS_MCP_SERVERS or KODEKS_MCP_SERVER_URL.",
            "parameters": {"type": "object", "properties": {}},
        },
        {
            "name": "list_skills",
            "description": "List available Kodeks skills from KODEKS_SKILLS_PATHS or the workspace .kodeks/skills directory.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "limit": {"type": "integer"},
                },
            },
        },
        {
            "name": "read_skill",
            "description": "Read one available skill's SKILL.md by name.",
            "parameters": {
                "type": "object",
                "properties": {"name": {"type": "string"}},
                "required": ["name"],
            },
        },
    ]
    if not read_only_only:
        return definitions
    read_only_names = {
        "read_file",
        "grep",
        "recall_memory",
        "read_memory_artifact",
        "spawn_explore_agent",
        "list_mcp_servers",
        "list_skills",
        "read_skill",
    }
    return [definition for definition in definitions if definition["name"] in read_only_names]
