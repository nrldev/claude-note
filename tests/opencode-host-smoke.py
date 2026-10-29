"""Opt-in real OpenCode V1 host test with synthetic memory and a local fake LLM.

Run: python3 tests/opencode-host-smoke.py
Requires opencode on PATH. Never reads personal chats, notes or provider keys.
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1] / 'src'
sys.path.insert(0, str(SOURCE))
from claude_note.opencode import install_plugin


def main():
    binary = shutil.which('opencode')
    if not binary:
        raise RuntimeError('OpenCode is required for the opt-in host smoke test')
    requests = []
    marker = 'SYNTHETIC_MEMORY_OPENCODE_71b4'
    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            requests.append(body)
            if body.get('stream'):
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()
                for delta, finish in (({'role': 'assistant', 'content': 'Synthetic response.'}, None), ({}, 'stop')):
                    event = {'id': 'chatcmpl-synthetic', 'object': 'chat.completion.chunk', 'created': 1,
                             'model': 'fixture', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
                    self.wfile.write(('data: ' + json.dumps(event) + '\n\n').encode())
                self.wfile.write(b'data: [DONE]\n\n')
            else:
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'id': 'chatcmpl-synthetic', 'object': 'chat.completion',
                    'created': 1, 'model': 'fixture', 'choices': [{'index': 0, 'message': {
                        'role': 'assistant', 'content': 'Synthetic response.'}, 'finish_reason': 'stop'}],
                    'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}}).encode())
    provider = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    thread = threading.Thread(target=provider.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix='claude-note-opencode-host-') as temporary:
            root = Path(temporary)
            (root / 'project').mkdir()
            executable = root / 'memory'
            calls = root / 'calls.jsonl'
            executable.write_text(f'''#!{sys.executable}
import json, sys
from pathlib import Path
sys.path.insert(0, {str(SOURCE)!r})
payload=json.load(sys.stdin)
with open({str(calls)!r}, 'a') as log: log.write(json.dumps({{"args":sys.argv[1:],"payload":payload}})+'\\n')
if sys.argv[1:]==['hook','recall']:
    print(json.dumps({{"hookSpecificOutput":{{"additionalContext":{marker!r}}}}}))
elif sys.argv[1:]==['opencode-capture']:
    from claude_note.opencode import capture
    print(json.dumps(capture(payload)))
else: print('{{}}')
''')
            executable.chmod(0o700)
            config = root / 'config/opencode'
            install_plugin(config / 'plugins', str(executable))
            configuration = {'$schema': 'https://opencode.ai/config.json',
                'model': 'memory-smoke/fixture', 'small_model': 'memory-smoke/fixture',
                'provider': {'memory-smoke': {'npm': '@ai-sdk/openai-compatible', 'name': 'Synthetic',
                    'options': {'baseURL': f'http://127.0.0.1:{provider.server_port}/v1', 'apiKey': 'synthetic'},
                    'models': {'fixture': {'name': 'Synthetic', 'limit': {'context': 16000, 'output': 1000}}}}}}
            (config / 'opencode.json').write_text(json.dumps(configuration))
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            env = {**os.environ, 'HOME': str(root), 'XDG_CONFIG_HOME': str(root / 'config'),
                   'XDG_DATA_HOME': str(root / 'data'), 'XDG_STATE_HOME': str(root / 'state'),
                   'CLAUDE_NOTE_VAULT': str(root / 'vault'), 'CLAUDE_NOTE_COMMAND': str(executable),
                   'OPENCODE_DISABLE_DEFAULT_PLUGINS': '1', 'OPENCODE_DISABLE_AUTOUPDATE': '1',
                   'OPENCODE_DISABLE_MODELS_FETCH': '1'}
            for key in ('OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_CONFIG_DIR'):
                env.pop(key, None)
            with (root / 'host.log').open('w+') as log:
                host = subprocess.Popen([binary, 'serve', '--port', str(port), '--hostname', '127.0.0.1'],
                    cwd=root / 'project', env=env, stdout=log, stderr=log)
                try:
                    def api(path, data=None):
                        request = urllib.request.Request(f'http://127.0.0.1:{port}' + path,
                            data=json.dumps(data).encode() if data is not None else None,
                            headers={'Content-Type': 'application/json'})
                        with urllib.request.urlopen(request, timeout=30) as response:
                            return json.load(response)
                    for _ in range(100):
                        try:
                            api('/global/health')
                            break
                        except (OSError, ValueError):
                            if host.poll() is not None: raise RuntimeError('OpenCode failed to start')
                            time.sleep(.1)
                    info = api('/session', {})
                    api(f'/session/{info["id"]}/message', {'model': {'providerID': 'memory-smoke', 'modelID': 'fixture'},
                        'parts': [{'type': 'text', 'text': 'Synthetic recall and session capture check.'}]})
                    for _ in range(100):
                        sources = list((root / '.local/share/claude-note/opencode-sources').glob('*.jsonl'))
                        batches = list((root / 'vault/.claude-note/queue').glob('import-*.jsonl'))
                        if sources and batches: break
                        time.sleep(.1)
                    assert any(marker in str(message.get('content')) for req in requests for message in req.get('messages', [])
                               if message.get('role') == 'system'), 'Memory did not reach the actual provider request'
                    assert sources and batches, 'Real OpenCode idle event did not publish the captured session'
                    captured = json.loads(sources[0].read_text())
                    assert captured['info']['id'] == info['id']
                    assert any(row['info']['role'] == 'assistant' for row in captured['messages'])
                    print(json.dumps({'host': subprocess.check_output([binary, '--version'], text=True).strip(),
                        'memory_reached_provider': True, 'session_capture_published': True,
                        'provider_requests': len(requests), 'synthetic_only': True}))
                except Exception:
                    log.flush()
                    log.seek(0)
                    print(log.read()[-12000:], file=sys.stderr)
                    raise
                finally:
                    host.terminate()
                    try: host.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        host.kill()
                        host.wait()
    finally:
        provider.shutdown()
        provider.server_close()


if __name__ == '__main__':
    main()
