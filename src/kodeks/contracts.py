"""Pydantic contracts that mirror the current TypeScript runtime boundary."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

ConfiguredModelApi = Literal["responses", "chat-completions"]
ReasoningEffort = Literal["none", "low", "medium", "high", "xhigh"]
SessionMode = Literal["act", "plan"]


class ConfiguredModelOption(BaseModel):
    """Secret-free model option returned to the existing frontend selector."""

    model_config = ConfigDict(populate_by_name=True)

    ref: str
    provider_id: str = Field(alias="providerId")
    provider_name: str = Field(alias="providerName")
    model_id: str = Field(alias="modelId")
    model_name: str = Field(alias="modelName")
    api: ConfiguredModelApi
    requires_bridge: bool = Field(alias="requiresBridge")
    base_url: str | None = Field(default=None, alias="baseURL")
    configured: bool


class ConfiguredModelCatalog(BaseModel):
    """Model catalog wire shape used by `/api/models`."""

    primary: str | None = None
    models: list[ConfiguredModelOption]


class StoredPlanStep(BaseModel):
    """One persisted plan step as embedded JSON in SQLite."""

    id: str
    title: str
    status: Literal["pending", "in_progress", "completed"]
    details: str | None = None


class StoredPlanArtifact(BaseModel):
    """Active plan artifact attached to a chat session."""

    id: str
    session_id: str = Field(alias="sessionId")
    title: str
    summary: str
    steps: list[StoredPlanStep]
    status: Literal["active", "archived"]
    source_message_id: str | None = Field(default=None, alias="sourceMessageId")
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")


class StoredSession(BaseModel):
    """Session metadata compatible with the TypeScript route response."""

    id: str
    title: str
    mode: SessionMode
    workspace_root: str = Field(alias="workspaceRoot")
    parent_session_id: str | None = Field(default=None, alias="parentSessionId")
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")
    archived_at: str | None = Field(default=None, alias="archivedAt")


class StoredMessage(BaseModel):
    """Transcript message persisted in the shared SQLite schema."""

    id: str
    session_id: str = Field(alias="sessionId")
    role: str
    content: Any
    agent_event: Any | None = Field(default=None, alias="agentEvent")
    created_at: str = Field(alias="createdAt")


class StoredApproval(BaseModel):
    """Approval record for dangerous command execution."""

    id: str
    session_id: str | None = Field(default=None, alias="sessionId")
    tool_call_id: str | None = Field(default=None, alias="toolCallId")
    command: Any
    status: Literal["pending", "approved", "rejected", "executed"]
    reason: str
    created_at: str = Field(alias="createdAt")
    decided_at: str | None = Field(default=None, alias="decidedAt")
