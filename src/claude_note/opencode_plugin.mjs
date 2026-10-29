// Claude Note OpenCode integration (managed by claude-note)
// OpenCode V1 (tested with 1.19.4). No second model server or package dependency.
import {spawn} from 'node:child_process';

const COMMAND = "__CLAUDE_NOTE_COMMAND__";
const RULES = `Claude Note shared memory is available through the existing local CLI.
Before acting on past work, incidents or decisions, search with claude-note recall "two or three content words".
Automatic recall is a shortlist of leads, not verified facts. Read each source and check current applicability.
A miss does not prove nothing is known: drop a word and search again.
Save durable lessons with claude-note remember --type gotcha "what, why, the fix"; choose gotcha, pattern or decision as appropriate.
Never retry failed auth, quota or disk-full commands unchanged.
Session capture queues local evidence; synthesis follows Claude Note's configured mode and source policy.`;
const UNAVAILABLE = 'Claude Note automatic recall is unavailable. Do not infer that no prior knowledge exists; retry with the memory CLI when needed.';
const MAX_INPUT = 16 * 1024 * 1024;

function invoke(args, payload, timeout = 10000) {
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > MAX_INPUT) return Promise.reject(new Error('Memory input exceeds 16 MiB'));
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.CLAUDE_NOTE_COMMAND || COMMAND, args, {
      stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    const output = [];
    let bytes = 0, failure;
    const kill = signal => {
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {}
    };
    const timer = setTimeout(() => {
      failure = new Error('Memory command timed out');
      kill('SIGKILL');
    }, timeout);
    const collect = (chunk, stdout) => {
      bytes += chunk.length;
      if (bytes > 65536) {
        failure = new Error('Memory command output exceeds bound');
        kill('SIGKILL');
      } else if (stdout) output.push(chunk);
    };
    child.stdout.on('data', chunk => collect(chunk, true));
    child.stderr.on('data', chunk => collect(chunk, false));
    child.stdin.on('error', () => {});
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure || code !== 0) reject(failure || new Error('Memory command failed'));
      else {
        try {
          const text = Buffer.concat(output).toString('utf8').trim();
          resolve(text ? JSON.parse(text) : {});
        } catch { reject(new Error('Invalid memory command response')); }
      }
    });
    child.stdin.end(body);
  });
}

const context = value => {
  const text = value?.hookSpecificOutput?.additionalContext;
  return typeof text === 'string' ? text.slice(0, 16384) : '';
};
const promptText = parts => parts.filter(p => p.type === 'text' && !p.synthetic && !p.ignored)
  .map(p => p.text).join('\n\n');

export default async function ClaudeNote({client, directory}) {
  const sessions = new Map(), capturing = new Map();
  const report = async message => {
    try { await client.app.log({body: {service: 'claude-note', level: 'warn', message}, signal: AbortSignal.timeout(2000)}); }
    catch {}
  };
  const recall = async (sessionID, prompt) => {
    if (!prompt.trim()) return '';
    try {
      return context(await invoke(['hook', 'recall'], {
        hook_event_name: 'UserPromptSubmit', session_id: sessionID, cwd: directory, prompt,
      }));
    } catch { await report('Automatic recall unavailable; use claude-note recall manually.'); return UNAVAILABLE; }
  };
  const rememberContext = (id, text) => {
    sessions.delete(id);
    sessions.set(id, text);
    if (sessions.size > 128) sessions.delete(sessions.keys().next().value);
  };
  const sessionData = async id => {
    const result = await client.session.get({path: {id}, signal: AbortSignal.timeout(5000)});
    if (result.error || !result.data) throw new Error('OpenCode session unavailable');
    return result.data;
  };
  const messages = async id => {
    const result = await client.session.messages({path: {id}, signal: AbortSignal.timeout(5000)});
    if (result.error || !Array.isArray(result.data)) throw new Error('OpenCode messages unavailable');
    return result.data;
  };
  const capture = async id => {
    if (capturing.has(id)) return capturing.get(id);
    const pending = (async () => {
      try {
        const info = await sessionData(id);
        if (info.parentID) return;
        await invoke(['opencode-capture'], {info, messages: await messages(id)}, 20000);
      } catch { await report('Session capture failed; original session remains in OpenCode. Retry on the next idle event or export it for recovery.'); }
    })();
    capturing.set(id, pending);
    try { await pending; } finally { capturing.delete(id); }
  };
  return {
    'shell.env': async (_input, output) => { output.env.CLAUDE_NOTE_ASSISTANT = 'opencode'; },
    'chat.message': async (input, output) => {
      rememberContext(input.sessionID, await recall(input.sessionID, promptText(output.parts)));
    },
    'experimental.chat.system.transform': async (input, output) => {
      if (!input.sessionID) return;
      if (!sessions.has(input.sessionID)) {
        try {
          const rows = await messages(input.sessionID);
          const latest = rows.findLast(row => row.info.role === 'user' && promptText(row.parts).trim());
          rememberContext(input.sessionID, latest ? await recall(input.sessionID, promptText(latest.parts)) : '');
        } catch { rememberContext(input.sessionID, UNAVAILABLE); }
      }
      output.system.push(RULES);
      const packet = sessions.get(input.sessionID);
      if (packet) output.system.push(packet);
    },
    'tool.execute.after': async (input, output) => {
      if (input.tool !== 'bash') return;
      const metadata = output.metadata || {};
      const exit = metadata.exit ?? metadata.exitCode;
      if (typeof exit !== 'number' || exit === 0) return;
      try {
        const packet = context(await invoke(['hook', 'sentinel'], {
          hook_event_name: 'PostToolUse', session_id: input.sessionID, cwd: directory,
          tool_name: 'Bash', tool_input: input.args,
          tool_response: {stdout: output.output.slice(-12000), exit_code: exit},
        }));
        if (packet) output.output += '\n<claude-note-sentinel>\n' + packet + '\n</claude-note-sentinel>';
      } catch { await report('Failure recall unavailable.'); }
    },
    'experimental.session.compacting': async (input, output) => {
      output.context.push(RULES);
      const packet = sessions.get(input.sessionID);
      if (packet) output.context.push(packet);
      await capture(input.sessionID);
    },
    event: async ({event}) => {
      if (event.type === 'session.idle' || event.type === 'session.error') {
        const id = event.properties?.sessionID;
        if (id) await capture(id);
      } else if (event.type === 'session.deleted') {
        sessions.delete(event.properties?.info?.id);
      }
    },
  };
}
