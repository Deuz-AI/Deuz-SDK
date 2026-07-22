## Learned User Preferences

- Prefer Turkish for chat replies when the user writes in Turkish; do not answer in Russian unless they ask for it.
- Challenge odd semver / release-doc names (e.g. `1.9.9`) and steer to the real minor (`1.9.0`) before writing root design docs.
- Keep README and public messaging realistic: position the SDK as a practical tool on the path toward ASI, not hype.
- Product bar for major work: Manus-style full autonomy, and compete with Mastra / Vercel AI SDK (aim near #2 among SDKs).
- Prefer Cursor AskQuestion-style turn endings over QingTian / `check_messages` MCP loops when those channels are disallowed.
- After a task is fully done, ask in Turkish whether to close the chat or if they want to add anything (unless they say to answer without closing).
- Treat dedicated AWS Bedrock and Azure OpenAI / Azure AI factories as wanted gaps to add and document clearly.

## Learned Workspace Facts

- npm-workspaces monorepo publishing `@deuz-sdk/core` (edge-safe AI SDK) and `@deuz-sdk/react` (thin React adapter).
- Code-verified release design specs live at the repo root as `X.Y.Z.md` (e.g. `1.9.0.md`); planning notes are often Turkish while public README/docs stay English.
- 1.8.0 “Otonom Ajan Runtime” centers on workspace, compute/CodeAct, planner→executor→verifier autonomy, browser, background runtime, plus published `./providers` and `./testing` subpaths.
- OpenAI-compatible routers (Mistral, DeepSeek, Qwen, Moonshot/Kimi, Groq, etc.) ship under `@deuz-sdk/core/providers`, not as first-class dedicated factories like `./anthropic` / `./openai`.
- Dedicated factory gaps called out in recent work: AWS Bedrock and Azure OpenAI / Azure AI.
- Core stays Web-API / edge-safe by default; Node-only code belongs under `src/node/**` or other exempt Node subpaths.
