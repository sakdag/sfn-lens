# Claude Desktop setup

1. Build the project (`npm install && npm run build`).
2. Edit `~/Library/Application Support/Claude/claude_desktop_config.json`.
3. Point `command`/`args` at `packages/server/dist/index.js`.
4. Set `AWS_PROFILE` / `AWS_REGION` to whatever your CLI already uses (or omit them and rely on the SDK default chain).
5. Fully quit and reopen Claude Desktop.
6. Confirm the `sfn-lens` tools appear, then ask for an execution ARN or use fixture mode.

Logs: Claude Desktop → Settings → Developer → MCP logs if the server fails to start.
