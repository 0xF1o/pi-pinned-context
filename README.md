# Pi Pinned Context

A [Pi Coding Agent](https://github.com/earendil-works/pi) extension that keeps a pinned system prefix and applies a sliding window to older conversational turns before each model request.

It does **not** delete transcript history, summarize messages, use memory/RAG, or disable Pi's normal compaction. Pi compaction remains available as a fallback.

## Install from GitHub

Clone the repository into Pi's extension directory:

```bash
mkdir -p ~/.pi/agent/extensions
rm -rf ~/.pi/agent/extensions/pinned-context
git clone https://github.com/0xF1o/pi-pinned-context.git \
  ~/.pi/agent/extensions/pinned-context
```

Start Pi normally. To load it explicitly while testing:

```bash
pi --extension ~/.pi/agent/extensions/pinned-context/index.ts
```

The extension imports Pi types. If the global Pi installation cannot resolve them from the cloned directory, install the package dependencies there:

```bash
cd ~/.pi/agent/extensions/pinned-context
npm install --ignore-scripts
```

## Configuration

Configuration is optional and lives at `~/.pi/agent/pinned-context.json`:

```json
{
  "maxContextPercent": 0.9,
  "minRecentTurns": 20,
  "debugLogging": false
}
```

- `maxContextPercent`: target fraction of the model context window, from `0.01` to `1`.
- `minRecentTurns`: minimum number of complete recent turns to retain. Defaults to `20`.
- `debugLogging`: write pruning statistics to stderr. Defaults to `false`.

The file is reloaded before each model request. Runtime debug overrides are available with `/pinned-context-debug on|off`.

## Commands

- `/pinned-context-status` — show statistics for the last filtered request.
- `/pinned-context-debug on|off` — enable or disable runtime debug logging.

## How it works

The `context_with_system` hook receives the complete request immediately before it is sent to the model. The extension:

1. Keeps system messages at the front of the request.
2. Groups user-like messages into complete turns.
3. Keeps assistant tool calls together with their tool results.
4. Drops the oldest complete turns until the configured target is met.
5. Returns a new request-local message array without changing the session transcript.

Pi's `custom`, `bashExecution`, `branchSummary`, and `compactionSummary` messages are treated as conversational because Pi converts them to user messages before sending them to the provider. Unknown extension roles remain pinned conservatively.

Token usage is estimated provider-neutrally at roughly four characters per token, plus a small per-message overhead. Exact provider tokenization is not available to extensions, so the default 90% target leaves headroom.

## Compaction

The extension does not intercept or disable Pi compaction. Normal automatic, manual, and overflow-recovery compaction can still occur. Request-local pruning is intended to reduce the need for compaction, not replace it.

## Development

The project is intentionally small and has no build step. Pi loads `index.ts` directly through its TypeScript loader.

Before opening a pull request, verify the extension with a local Pi session and test:

- long conversations with tool calls;
- custom and summary messages;
- very large system prompts;
- small context windows;
- manual and automatic compaction.

## License

See [LICENSE](LICENSE).
