# Pi Pinned Context

A [Pi Coding Agent](https://github.com/earendil-works/pi) extension that keeps a pinned system prefix and applies a sliding window to older conversational turns before each model request.

It does **not** delete transcript history, summarize messages, use memory/RAG, or disable Pi's normal compaction. Pi compaction remains available as a fallback.

## Installation

Install the extension from GitHub with:

```bash
pi install https://github.com/0xF1o/pi-pinned-context.git
```

To load a local checkout explicitly:

```bash
pi --extension ../path/to/pi-pinned-context
```

## Configuration

Configuration is optional and lives at `~/.pi/agent/pinned-context.json`:

```json
{
  "maxContextPercent": 0.9,
  "minRecentTurns": 20
}
```

- `maxContextPercent`: target fraction of the model context window, from `0.01` to `1`.
- `minRecentTurns`: minimum number of complete recent turns to retain. Defaults to `20`.

The file is reloaded before each model request. Use `/pinned-context-min-turns <n>` to override `minRecentTurns` for the active session without changing the file. Use `/pinned-context-set-turns <n>` when an exact recent-turn limit is desired.

## Commands

- `/pinned-context-status` — show statistics for the last filtered request, including a table of every turn and whether it is used or dropped.
- `/pinned-context-min-turns <n>` — change the minimum retained-turn floor for the active session. This does not modify the configuration file.
- `/pinned-context-set-turns <n>` — keep only the `n` most recent turns for the active session; older turns are omitted from model requests.

## How it works

The `context_with_system` hook receives the complete request immediately before it is sent to the model. The extension:

1. Keeps system messages at the front of the request.
2. Groups user-like messages into complete turns.
3. Keeps assistant tool calls together with their tool results.
4. Drops the oldest complete turns until the configured target is met.
5. Returns a new request-local message array without changing the session transcript.

### Visual example

The full session remains intact, but the request sent to the model becomes a pinned prefix followed by the newest complete turns:

```text
Full session / transcript

+------------------+------+------+------+------+------+
| Pinned system    | T1   | T2   | T3   | T4   | T5   |
| prompt + tools   |      |      |      |      |      |
+------------------+------+------+------+------+------+
                    ^^^^^  ^^^^^  ^^^^^  ^^^^^  ^^^^^
                    older turns remain in the transcript

Context request after budget pruning

+------------------+------+------+------+------+------+
| Pinned system    | T1   | T2   | T3   | T4   | T5   |
| prompt + tools   |      |      |      |      |      |
+------------------+------+------+------+------+------+
                                  ^^^^^  ^^^^^  ^^^^^
                    dropped from this request: T1, T2
```

A turn is kept or dropped as a whole. For example, an assistant tool call and its result stay together:

```text
T4 = user message -> assistant tool call -> tool result -> assistant reply
```

With `/pinned-context-set-turns 2`, the request would instead contain the pinned prefix plus `T4` and `T5`. The dropped turns are not deleted and remain available in the session transcript.

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
