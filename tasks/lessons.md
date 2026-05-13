# Lessons

- When explaining `uv add --extra <name>` with multiple packages, remember that uv can apply the requested extra to all added dependencies in that invocation. Prefer the explicit dependency syntax, for example `uv add "fastapi[standard]" openai python-dotenv pydantic`, when only one package should receive an extra.
- In coaching mode for this project, do not treat missing function-level docstrings as a student review finding. Add or polish docstrings directly when needed, and keep reviews focused on structure, behavior, correctness, and concepts.
- In coaching mode, make the project interview-oriented: for each milestone, explain the real engineering problem solved, the business/product need behind it, likely interviewer questions, and a concise answer the user can practice.
- In coaching mode, prioritize real requirements, business scenarios, architecture, security boundaries, and engineering taste over low-level Python syntax details. Explain syntax only when it blocks the user from understanding the design.
- Before moving to the next milestone, add short Chinese Python comments at the top of the most relevant code files using `q1/a1`, `q2/a2` style interview notes. Important business/security modules may include more than one Q&A.
- Code-top interview notes should read like an interviewer can understand without seeing the surrounding code: start from product/business context, then implementation, then follow-up questions.
- At the end of each phase, write a richer HTML review note under `docs/notes/phaseN.html` that explains the phase from business requirement, architecture, safety boundary, verification, and interview angles.
