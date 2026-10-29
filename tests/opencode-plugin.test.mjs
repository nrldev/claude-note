import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import plugin from '../src/claude_note/opencode_plugin.mjs';

async function fixture(t, mode = 'normal') {
  const root = mkdtempSync(join(tmpdir(), 'claude-note-opencode-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const executable = join(root, 'fake-memory.mjs'), log = join(root, 'calls');
  writeFileSync(executable, `#!/usr/bin/env node
import fs from 'node:fs';
let raw=''; for await(const chunk of process.stdin) raw+=chunk;
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args:process.argv.slice(2),payload:JSON.parse(raw)})+'\\n');
if(${JSON.stringify(mode)}==='invalid'){process.stdout.write('invalid json');process.exit(0);}
if(${JSON.stringify(mode)}==='large'){process.stdout.write('x'.repeat(70000));process.exit(0);}
const text=process.argv[3]==='sentinel'?'synthetic fix':'synthetic remembered decision';
console.log(JSON.stringify({hookSpecificOutput:{additionalContext:text}}));
`, {mode: 0o700});
  const prior = process.env.CLAUDE_NOTE_COMMAND;
  process.env.CLAUDE_NOTE_COMMAND = executable;
  t.after(() => { if (prior === undefined) delete process.env.CLAUDE_NOTE_COMMAND; else process.env.CLAUDE_NOTE_COMMAND = prior; });
  const rows = [{info: {role: 'user'}, parts: [{type: 'text', text: 'Original request'}]}];
  const info = {id: 'ses_synthetic', directory: root};
  const warnings = [];
  const hooks = await plugin({directory: root, client: {
    app: {log: async value => warnings.push(value)},
    session: {get: async () => ({data: info}), messages: async () => ({data: rows})},
  }});
  return {hooks, info, rows, warnings, calls: () => readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)};
}

test('recall enters the model system context without changing the user prompt', async t => {
  const {hooks, calls} = await fixture(t);
  const parts = [{type: 'text', text: 'Keep the cache'}, {type: 'text', text: 'synthetic ignored', synthetic: true}];
  const before = structuredClone(parts);
  await hooks['chat.message']({sessionID: 'ses_synthetic'}, {parts});
  const output = {system: ['existing']};
  await hooks['experimental.chat.system.transform']({sessionID: 'ses_synthetic'}, output);
  await hooks['experimental.chat.system.transform']({sessionID: 'ses_synthetic'}, {system: []});
  assert.deepEqual(parts, before);
  assert.equal(calls().length, 1);
  assert.equal(calls()[0].payload.prompt, 'Keep the cache');
  assert.equal(output.system[0], 'existing');
  assert.equal(output.system.at(-1), 'synthetic remembered decision');
  const shell = {env: {EXISTING: 'kept'}};
  await hooks['shell.env']({}, shell);
  assert.deepEqual(shell.env, {EXISTING: 'kept', CLAUDE_NOTE_ASSISTANT: 'opencode'});
});

test('resumed sessions recall their last genuine user message and preserve compaction context', async t => {
  const {hooks, calls, rows} = await fixture(t);
  rows.push({info: {role: 'user'}, parts: [{type: 'text', text: 'synthetic continue', synthetic: true}]});
  await hooks['experimental.chat.system.transform']({sessionID: 'ses_synthetic'}, {system: []});
  const output = {context: ['existing summary']};
  await hooks['experimental.session.compacting']({sessionID: 'ses_synthetic'}, output);
  assert.equal(calls()[0].payload.prompt, 'Original request');
  assert.equal(output.context.at(-1), 'synthetic remembered decision');
  assert.equal(calls()[1].args[0], 'opencode-capture');
});

test('sentinel annotates only failed shell tools and preserves their original output', async t => {
  const {hooks, calls} = await fixture(t);
  const output = {output: 'failed command', metadata: {exit: 1}};
  await hooks['tool.execute.after']({tool: 'bash', sessionID: 'ses_synthetic', args: {command: 'synthetic'}}, output);
  assert.ok(output.output.startsWith('failed command\n<claude-note-sentinel>'));
  assert.ok(output.output.includes('synthetic fix'));
  await hooks['tool.execute.after']({tool: 'bash'}, {output: 'success says error', metadata: {exit: 0}});
  await hooks['tool.execute.after']({tool: 'read'}, {output: 'file says error', metadata: {exit: 1}});
  assert.equal(calls().length, 1);
});

test('idle capture exports original parts and skips subagent sessions', async t => {
  const {hooks, calls, info, rows} = await fixture(t);
  await hooks.event({event: {type: 'session.idle', properties: {sessionID: 'ses_synthetic'}}});
  assert.deepEqual(calls()[0].payload, {info, messages: rows});
  info.parentID = 'parent';
  await hooks.event({event: {type: 'session.idle', properties: {sessionID: 'ses_synthetic'}}});
  assert.equal(calls().length, 1);
});

test('bad or oversized subprocess responses fail open with an explicit memory notice', async t => {
  for (const mode of ['invalid', 'large']) {
    const {hooks, warnings} = await fixture(t, mode);
    await hooks['chat.message']({sessionID: 'ses_synthetic'}, {parts: [{type: 'text', text: 'request'}]});
    const output = {system: []};
    await hooks['experimental.chat.system.transform']({sessionID: 'ses_synthetic'}, output);
    assert.match(output.system.at(-1), /unavailable/);
    assert.equal(warnings.length, 1);
  }
});
