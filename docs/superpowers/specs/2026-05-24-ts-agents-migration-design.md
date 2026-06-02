# TS Agents Migration Design

## Status

Superseded archival note. This file records that an earlier implementation
direction existed, but it is not an active migration plan, runtime contract, or
stack recommendation.

The active repository has migrated away from the TypeScript OpenAI/Agents SDK
workspace. Do not use this archived note to recreate TypeScript SDK packages,
Next.js routes, a pnpm workspace, Node build tooling, or a second backend.

## Current Authority

- `docs/MODERNIZATION.md`: Python migration inventory, stack map, checkpoints,
  validation gates, external risks, and rollback boundary.
- `docs/PRD.md`: product scope and reference-path boundaries.
- `docs/architecture.md`: current Python/FastAPI runtime architecture.
- `src/kodeks/*`: active Python implementation surface.
- `tests/test_migration_contracts.py`: repository contracts that keep the
  active workspace Python-only.

## Historical Boundary

The former TypeScript design was useful as planning context during an earlier
phase. Its implementation details are intentionally not preserved here because
the current migration objective is the opposite direction: Python OpenAI SDK,
Python OpenAI Agents SDK, FastAPI routes, Python-hosted static UI, and uv-based
validation.
