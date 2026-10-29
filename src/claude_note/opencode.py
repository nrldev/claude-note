"""OpenCode V1 plugin installation and lossless local session capture."""
import hashlib
import json
import os
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

from . import state_io

MAX_EXPORT_BYTES = 16 * 1024 * 1024
PLUGIN_HEADER = '// Claude Note OpenCode integration (managed by claude-note)'


def add_parsers(sub):
    install = sub.add_parser('install-opencode', help='Install OpenCode V1 recall, sentinel and capture plugin')
    install.add_argument('--plugin-dir', default='', help='Override ~/.config/opencode/plugins')
    install.add_argument('--command', dest='command_path', default='', help='Absolute claude-note executable')
    install.add_argument('--dry-run', action='store_true')
    sub.add_parser('opencode-capture', help='Capture an OpenCode session export from stdin (local only)')


def install_plugin(plugin_dir=None, command=None, *, dry_run=False):
    root = Path(plugin_dir) if plugin_dir else Path(os.environ.get('XDG_CONFIG_HOME', str(Path.home() / '.config'))) / 'opencode/plugins'
    target = root.expanduser().absolute() / 'claude-note.js'
    executable = command or shutil.which('claude-note')
    if not executable or not Path(executable).is_absolute():
        raise ValueError('An absolute claude-note executable is required')
    template = Path(__file__).with_name('opencode_plugin.mjs').read_text()
    body = template.replace('"__CLAUDE_NOTE_COMMAND__"', json.dumps(str(executable)))
    if target.is_symlink():
        raise ValueError('Refusing to replace a symlinked plugin')
    if target.exists() and not target.read_text().startswith(PLUGIN_HEADER + '\n'):
        raise ValueError('Existing plugin is not managed by Claude Note')
    if not dry_run:
        state_io.atomic_bytes(target, body.encode())
    return target


def _timestamp(value):
    if type(value) not in (int, float):
        return ''
    return datetime.fromtimestamp(value / 1000, timezone.utc).isoformat()


def normalize(payload):
    """Preserve IDs, user corrections, tool inputs/results and explicit outcomes.

    The unmodified export is kept separately; synthetic/ignored prompt context
    and reasoning are not promoted to user requests or durable lessons.
    """
    if not isinstance(payload, dict) or not isinstance(payload.get('info'), dict):
        raise ValueError('Expected an OpenCode session export')
    info = payload['info']
    session = info.get('id')
    if not isinstance(session, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', session):
        raise ValueError('Invalid OpenCode session identity')
    if info.get('parentID'):
        return info, []  # agent/subagent sessions are not a human conversation
    cwd = info.get('directory')
    if not isinstance(cwd, str) or not Path(cwd).is_absolute():
        raise ValueError('Expected an absolute OpenCode working directory')
    rows = payload.get('messages')
    if not isinstance(rows, list):
        raise ValueError('Expected OpenCode messages')
    messages = []
    seen = set()
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get('info'), dict) or not isinstance(row.get('parts'), list):
            raise ValueError('Malformed OpenCode message')
        meta = row['info']
        if meta.get('sessionID') != session or meta.get('role') not in ('user', 'assistant'):
            raise ValueError('Message does not belong to the OpenCode session')
        identity = meta.get('id')
        if not isinstance(identity, str) or not identity or identity in seen:
            raise ValueError('Invalid or duplicate OpenCode message identity')
        seen.add(identity)
        text, tools = [], []
        for part in row['parts']:
            if not isinstance(part, dict) or part.get('messageID') != identity or part.get('sessionID') != session:
                raise ValueError('Part does not belong to its OpenCode message')
            if part.get('type') == 'text' and not part.get('synthetic') and not part.get('ignored'):
                if not isinstance(part.get('text'), str):
                    raise ValueError('Malformed OpenCode text')
                text.append(part['text'])
            elif part.get('type') == 'tool' and meta['role'] == 'assistant':
                state = part.get('state')
                if not isinstance(state, dict) or not isinstance(state.get('input'), dict):
                    raise ValueError('Malformed OpenCode tool state')
                name = part.get('tool')
                if not isinstance(name, str) or not isinstance(part.get('callID'), str):
                    raise ValueError('Malformed OpenCode tool identity')
                inputs = dict(state['input'])
                for key in ('filePath', 'file_path', 'path'):
                    if isinstance(inputs.get(key), str):
                        inputs.setdefault('file_path', inputs[key])
                tool = {'id': part['callID'], 'name': 'Bash' if name == 'bash' else name, 'input': inputs}
                if state.get('status') == 'completed':
                    if not isinstance(state.get('output'), str):
                        raise ValueError('Malformed OpenCode tool output')
                    tool['output'] = state['output'].split('\n<claude-note-sentinel>\n', 1)[0]
                    metadata = state.get('metadata') or {}
                    exit_code = metadata.get('exit', metadata.get('exitCode'))
                    if type(exit_code) is int:
                        tool['exit_code'] = exit_code
                elif state.get('status') == 'error':
                    if not isinstance(state.get('error'), str):
                        raise ValueError('Malformed OpenCode tool error')
                    tool.update(output=state['error'], is_error=True)
                elif state.get('status') not in ('pending', 'running'):
                    raise ValueError('Unsupported OpenCode tool state')
                tools.append(tool)
        messages.append({'role': meta['role'], 'id': identity, 'parent_id': meta.get('parentID', ''),
                         'timestamp': _timestamp((meta.get('time') or {}).get('created')),
                         'text': '\n\n'.join(text), 'tools': tools})
    return info, messages


def capture(payload):
    from . import importers
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode() + b'\n'
    if len(raw) > MAX_EXPORT_BYTES:
        raise ValueError('OpenCode export exceeds 16 MiB; original session retained in OpenCode')
    info, messages = normalize(payload)
    if info.get('parentID'):
        return {'status': 'skipped', 'reason': 'subagent session'}
    if not any(m['role'] == 'user' and m['text'].strip() for m in messages) or not any(
            m['role'] == 'assistant' and (m['text'].strip() or m['tools']) for m in messages):
        return {'status': 'skipped', 'reason': 'no completed conversation'}
    # Keep the native export immutable, including unsupported attachment/part
    # fields, before publishing the normalized view. Publication receipts supply
    # retry deduplication, so this adapter does not mutate the sweep's seen file.
    digest = hashlib.sha256(raw).hexdigest()
    source = importers.TRANSCRIPTS_DIR.parent / 'opencode-sources' / (digest + '.jsonl')
    state_io.create_bytes(source, raw)
    queued = importers.write_session({}, 'opencode', info['id'], messages,
                                    info['directory'], origin_sources=[source])
    return {'status': 'queued' if queued else 'unchanged', 'source': str(source)}


def main(args):
    try:
        if args.command == 'install-opencode':
            path = install_plugin(args.plugin_dir, args.command_path, dry_run=args.dry_run)
            print(('Would install ' if args.dry_run else 'Installed ') + str(path))
            print('Restart OpenCode to load the plugin. Uses the existing Claude Note configuration and source policy.')
        else:
            raw = sys.stdin.buffer.read(MAX_EXPORT_BYTES + 1)
            if len(raw) > MAX_EXPORT_BYTES:
                raise ValueError('OpenCode export exceeds 16 MiB')
            print(json.dumps(capture(json.loads(raw))))
        return 0
    except (OSError, ValueError, TypeError, KeyError, OverflowError) as error:
        print('claude-note OpenCode: ' + str(error), file=sys.stderr)
        return 1
