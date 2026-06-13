"""Lightweight harness pattern selection for Kodeks turns."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

HarnessPattern = Literal[
    "single_turn",
    "fanout_synthesize",
    "adversarial_verify",
    "loop_until_done",
    "tournament",
]


@dataclass(frozen=True)
class HarnessDecision:
    """Describe the bounded harness shape selected for one chat turn."""

    pattern: HarnessPattern
    reasons: list[str]
    failure_modes: list[str]
    stop_condition: str
    approval_boundary: str
    subagent_contract: dict[str, str]

    def to_payload(self) -> dict[str, object]:
        """Return a JSON-safe payload for audit logs and runtime context."""

        return {
            "pattern": self.pattern,
            "reasons": self.reasons,
            "failureModes": self.failure_modes,
            "stopCondition": self.stop_condition,
            "approvalBoundary": self.approval_boundary,
            "subagentContract": self.subagent_contract,
        }


def select_harness_pattern(user_input: str, mode: str) -> HarnessDecision:
    """Select one small harness pattern without creating a generic workflow engine."""

    lowered = user_input.lower()
    text = f" {lowered} "
    if _contains_any(
        text,
        [
            "flaky",
            "intermittent",
            "1 in 50",
            "don't stop",
            "dont stop",
            "until",
            "loop",
            "rerun",
            "偶发",
            "复现",
            "不要停",
            "直到",
            "循环",
        ],
    ):
        return _decision(
            "loop_until_done",
            "task has an unknown amount of work or requires repeated evidence checks",
            ["agentic_laziness", "goal_drift"],
            "stop only when the stated condition is met or the explicit budget is exhausted",
        )
    if _contains_any(
        text,
        [
            "verify",
            "review",
            "security",
            "audit",
            "claim",
            "rubric",
            "double-check",
            "double check",
            "adversarial",
            "skeptic",
            "验证",
            "审查",
            "核对",
            "反驳",
            "质疑",
            "安全",
        ],
    ):
        return _decision(
            "adversarial_verify",
            "task quality depends on an explicit independent check",
            ["self_preferential_bias", "goal_drift"],
            "stop after findings are checked against the rubric and unresolved risks are surfaced",
        )
    if _contains_any(
        text,
        [
            "tournament",
            "rank",
            "top 3",
            "top three",
            "brainstorm",
            " name ",
            "naming",
            "taste",
            "compare",
            "排序",
            "排名",
            "命名",
            "取名",
            "比较",
            "品味",
        ],
    ):
        return _decision(
            "tournament",
            "task benefits from comparative judgment rather than one absolute answer",
            ["self_preferential_bias"],
            "stop after candidates are deduped and compared against the rubric",
        )
    if _contains_any(
        text,
        [
            "rename",
            "migration",
            "migrate",
            "refactor",
            "everywhere",
            "last 50",
            "80 resumes",
            "many",
            "batch",
            "parallel",
            "批量",
            "迁移",
            "重构",
            "全部",
            "到处",
            "并行",
        ],
    ):
        return _decision(
            "fanout_synthesize",
            "task can be split across files, items, or evidence sources",
            ["agentic_laziness", "goal_drift"],
            "stop after all partitions report structured outputs and the synthesis is checked",
        )
    if mode == "plan":
        return _decision(
            "single_turn",
            "plan mode keeps ordinary planning read-only and compact",
            ["goal_drift"],
            "stop after a clear plan artifact is produced",
        )
    return _decision(
        "single_turn",
        "ordinary coding turn does not need extra agent compute",
        [],
        "stop when the requested turn is answered or a tool boundary requires approval",
    )


def _decision(
    pattern: HarnessPattern,
    reason: str,
    failure_modes: list[str],
    stop_condition: str,
) -> HarnessDecision:
    """Build a standard decision payload for the selected harness pattern."""

    return HarnessDecision(
        pattern=pattern,
        reasons=[reason],
        failure_modes=failure_modes,
        stop_condition=stop_condition,
        approval_boundary=(
            "Subagents are read-only by default; workspace mutation, shell risk, "
            "and memory rule changes return to the main agent or user approval."
        ),
        subagent_contract={
            "claim": "state the explored conclusion",
            "evidence": "name files, memories, or tool outputs inspected",
            "risk": "surface uncertainty or missing evidence",
            "confidence": "low, medium, or high",
            "nextAction": "recommend the next bounded action",
        },
    )


def _contains_any(text: str, needles: list[str]) -> bool:
    """Return whether text contains any trigger phrase."""

    return any(needle in text for needle in needles)
