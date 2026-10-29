# OpenCode V1 integration

Tested with OpenCode and `@opencode-ai/plugin` 1.19.4. OpenCode V2 has a different
plugin API and is not supported by this adapter. This integration reuses the
configured Claude Note vault, recall engine, worker, synthesis mode and source
policy; it does not start another embedding/reranking service.

## Install

```bash
claude-note install-opencode --dry-run
claude-note install-opencode
```

Restart OpenCode after installing or updating. The installer writes only the
managed `claude-note.js` plugin in `$XDG_CONFIG_HOME/opencode/plugins` (default
`~/.config/opencode/plugins`). It preserves other plugins and OpenCode config,
rejects symlinks or an authored file at that name, and records the absolute
Claude Note executable. `--plugin-dir` and `--command` override these locations.
The plugin needs no additional npm packages.

## Behavior

* `chat.message` recalls the genuine user prompt through `claude-note hook recall`.
  `experimental.chat.system.transform` adds the bounded source-linked result to
  model context. It does not rewrite the persisted user message. Resumed sessions
  can recover their last real prompt through the OpenCode SDK.
* `tool.execute.after` sends failed `bash` results with a numeric exit status to
  the existing sentinel, appending advice after the original result. Successful
  tools and error-looking file contents do not trigger it.
* `experimental.session.compacting` preserves the memory instructions and captures
  the conversation before compaction.
* `session.idle` and `session.error` capture a top-level human session. Child
  sessions are skipped. Identical captures use existing publication receipts;
  subsequent turns create new revisions of the same logical session.
* `shell.env` sets `CLAUDE_NOTE_ASSISTANT=opencode`, so CLI `remember` operations
  keep their producer identity. The system instructions describe manual `recall`
  and `remember` commands using OpenCode's existing shell tool.

Subprocesses use argument arrays, bounded input/output and deadlines. Unavailable
recall adds an explicit notice without failing the prompt; capture failures go
to the OpenCode application log and leave the original session available there.

## Evidence and synthesis

`claude-note opencode-capture` accepts the OpenCode export shape
`{"info": <session>, "messages": [{"info": <message>, "parts": [...]}]}` on stdin.
Exports larger than 16 MiB are rejected, never silently shortened.

An immutable native export is stored under
`~/.local/share/claude-note/opencode-sources/<sha256>.jsonl`. The normalized
transcript uses `transcripts/opencode/` with `assistant: opencode` provenance,
and goes through the existing atomic import publication/queue path. The raw
export preserves unsupported parts and attachments. The synthesis view retains
user corrections, assistant text, tool inputs and outputs, IDs and explicit
outcomes. Synthetic/ignored text, reasoning and the plugin's sentinel advice are
not promoted into user requests or lessons. Unknown tool outcomes stay unknown.

Capture success means local evidence was queued. Knowledge extraction still
requires the worker and Claude CLI, and follows `inbox`/`route`/`log` mode.
Installation does not broaden model or staging egress. To permit synthesis,
the configured policy must allow the native exports, normalized transcripts and
all actual derivation sources (for example project files read by tools) for the
`model` audience. An illustrative opt-in configuration is:

```toml
[[egress.rules]]
source = "/home/you/.local/share/claude-note/opencode-sources/*"
audiences = ["local", "host", "model"]

[[egress.rules]]
source = "/home/you/.local/share/claude-note/transcripts/opencode/*"
audiences = ["local", "host", "model"]
```

Grant only the projects you intend to synthesize as well. Existing source-level
restrictions still apply; copying content into an export does not remove them.
See [source policy](configuration.md#source-egress-policy).

## Recovery and removal

If an idle capture fails, another idle event or compaction retries the current
session. There is no automatic recovery sweep of OpenCode's database in this
version. To recover explicitly, export the session and feed that JSON to capture:

```bash
opencode export SESSION_ID > session.json
claude-note opencode-capture < session.json
```

Keep the original export until capture and worker processing are verified.
Remove the managed plugin and restart OpenCode to disable the integration; this
does not remove captured notes or sources. `CLAUDE_NOTE_COMMAND` can select a
different executable for isolated testing.

## Verification

```bash
PYTHONPATH=src python3 -m unittest discover -s tests -p 'test_opencode.py' -v
node tests/opencode-plugin.test.mjs
python3 tests/opencode-host-smoke.py
```

The opt-in host smoke test starts real OpenCode with an isolated home/config,
synthetic memory and a local fake OpenAI-compatible model. It asserts that memory
reaches the actual provider request and that the idle event publishes capture.
It does not read personal conversations, use real provider credentials, or invoke
the synthesis model. Tests validate integration behavior, not retrieval quality.
