# Treat Codex as a model provider, not an agent runtime

The OpenAI Codex integration supplies subscription-authenticated model inference to Qwen Code while Qwen Code retains ownership of prompts, orchestration, tools, approvals, sessions, and UI. It authenticates independently and neither invokes the official Codex CLI nor shares its credential files, keeping the public fork portable and preventing two clients from coupling their session lifecycles.
