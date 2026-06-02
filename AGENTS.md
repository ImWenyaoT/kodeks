## TL;DR

- 请保持对话语言为中文。
- 用户系统可能是 Mac、Windows 或 Linux。
- 生成代码时添加函数级注释。

## Python Runtime Defaults

- Use `uv run` or the project's existing Python environment.
- Run focused tests after each migration checkpoint, then run the full Python gate before handoff.
- Keep the active runtime Python-only: do not reintroduce TypeScript SDK packages, Next.js routes, Node workspace manifests, or Node build tooling.
- Treat `~/.kodeks/config.json` as the user-level model configuration source. Do not put provider secrets in repo-local files.
- When model configuration changes, fill and validate the new configuration before removing old aliases or local secret files.

## Data Analysis Defaults

- Keep source data in `data/raw/` and write cleaned data to `data/processed/`.
- Put exploratory notebooks in `analysis/` and final artifacts in `output/`.
- Never overwrite raw files.
- Prefer scripts or checked-in notebooks over unnamed scratch cells.
- Before merging datasets, report candidate keys, null rates, and join coverage.

## Review Guidelines

- Flag typos and grammar issues as P0 issues.
- Flag potential missing documentation as P1 issues.
- Flag missing tests as P1 issues.

## Documentation

- When user-facing behavior changes, check whether docs, examples, or changelogs need updates.
- Public docs must only include public information or behavior visible in this repo.
- Preserve existing terminology and frontmatter.
- Run the docs formatting and build checks before final handoff.
