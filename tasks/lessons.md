# Lessons

- When explaining `uv add --extra <name>` with multiple packages, remember that uv can apply the requested extra to all added dependencies in that invocation. Prefer the explicit dependency syntax, for example `uv add "fastapi[standard]" openai python-dotenv pydantic`, when only one package should receive an extra.
- In coaching mode for this project, do not treat missing function-level docstrings as a student review finding. Add or polish docstrings directly when needed, and keep reviews focused on structure, behavior, correctness, and concepts.
