# Prompts

Versioned system prompts for every LLM task (embargo.md Part 10.4), loaded by `src/ai/prompts.ts`.

- File name: `<task>.v<N>.md`. The highest version is used unless `PROMPT_<TASK>=vN` pins one (e.g. `PROMPT_COMPRESS_BLOCK=v1`).
- `{{name}}` placeholders are filled at call time; `<!-- ... -->` comments are stripped.
- Never edit a released version in place: add `<task>.v2.md`. The version used is stored with its output:
  `block_versions.prompt_versions` (ingest), `suggestions.evidence.prompt_versions` (context manager),
  and `access_logs.decision.prompt_versions` (sealed use). `heuristic` means no LLM was configured or it failed.
