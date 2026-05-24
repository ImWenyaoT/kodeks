# Legacy Python Backend

This folder preserves the original Python/FastAPI implementation for migration reference only.

The active app now lives in the TypeScript workspace:

- `apps/web`
- `packages/agent-runtime`
- `packages/model`
- `packages/tools`
- `packages/workspace`
- `packages/storage`
- `packages/shared`

Run the legacy backend from this folder only when comparing old behavior:

```bash
uv sync
uv run fastapi dev src/kodeks/main.py
uv run python -m unittest discover -s tests -v
```
