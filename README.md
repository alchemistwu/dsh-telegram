# dsh-telegram

Minimal, robust Telegram bridge for DSH — chat with your agent from your phone.

Zero runtime dependencies: hand-rolled long-polling transport over `fetch`,
plain cordis plugin, strip-only TypeScript. ~800 lines.

## Features

- **Inbound → agent turn**: messages create/resume sessions and deliver via the
  agent-loop API (`followup`), with preset mounting, workspace attachment, and
  automatic `TG MM-DD HH:mm <hint>` titles
- **Outbound**: typing indicator on turn start, `🔧 <tool>` progress events,
  final assistant text on turn end
- **ask_user_question answerer**: agent questions render as numbered Telegram
  messages; reply with a number (multi: `1,2`) or free text. Without this the
  agent blocks forever — the only other answerer lives in the web UI
- **Commands**: `/new [hint]`, `/sessions` (numbered menu, newest first),
  `/use <n|title word|id prefix>` (resumes offline sessions), `/status`, `/stop`
- **Safety**: `allowedChatIds` allowlist (fail-closed), durable update offset,
  429 `retry_after` backoff

## Config

```yaml
- id: telegram
  config:
    allowedChatIds: [123456789]
    workspacePath: /path/to/workspace   # optional; defaults to first registered workspace
    model:                              # optional
      provider: modal
      model: zai-org/GLM-5.3-Flash
```

Bot token resolution: `config.token` → `TELEGRAM_BOT_TOKEN` env →
`.telegram-token` file next to the package.

## Development

```
npm test          # 28 tests: unit + e2e (real apply() through a fake network)
probe/            # runtime contract probe — boots in a real profile and
                  # executes every service call the plugin makes, because
                  # mocks encode the author's beliefs; the probe encodes nothing
```

## License

MIT
