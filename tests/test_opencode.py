"""Synthetic OpenCode exports; no user conversations or model calls."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

os.environ.setdefault('CLAUDE_NOTE_VAULT_ROOT', '/tmp/claude-note-test-opencode-vault')
from claude_note import config, egress, importers, opencode, provenance, queue_manager
from claude_note.transcript_reader import read_transcript


def export():
    def part(message, kind, **fields):
        return dict(id='p-' + message + kind, sessionID='ses_test', messageID=message, type=kind, **fields)
    return {'info': {'id': 'ses_test', 'directory': '/synthetic/project', 'title': 'Synthetic'}, 'messages': [
        {'info': {'id': 'u1', 'sessionID': 'ses_test', 'role': 'user', 'time': {'created': 1000}},
         'parts': [part('u1', 'text', text='Keep the existing cache.'),
                   part('u1', 'text', text='Injected memory is not a user decision', synthetic=True)]},
        {'info': {'id': 'a1', 'sessionID': 'ses_test', 'role': 'assistant'},
         'parts': [part('a1', 'text', text='Checking the cache.'),
                   part('a1', 'tool', callID='call1', tool='bash', state={
                       'status': 'completed', 'input': {'command': 'synthetic-command'},
                       'output': 'failure\n<claude-note-sentinel>\nInjected fix\n</claude-note-sentinel>',
                       'metadata': {'exit': 2}}),
                   part('a1', 'tool', callID='call2', tool='read', state={
                       'status': 'completed', 'input': {'filePath': '/synthetic/cache'},
                       'output': 'cached content', 'metadata': {}}),
                   part('a1', 'file', url='file:///synthetic/attachment', mime='text/plain')]},
        {'info': {'id': 'u2', 'sessionID': 'ses_test', 'role': 'user'},
         'parts': [part('u2', 'text', text='Correction: keep the new cache instead.')]},
    ]}


class OpenCodeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for module, name, value in (
            (config, 'QUEUE_DIR', self.root / 'queue'), (config, 'STATE_DIR', self.root / 'state'),
            (importers, 'TRANSCRIPTS_DIR', self.root / 'claude-note/transcripts'),
        ):
            patch = mock.patch.object(module, name, value)
            patch.start()
            self.addCleanup(patch.stop)
        patch = mock.patch.object(egress, 'policy', return_value={'default': ['local', 'host']})
        patch.start()
        self.addCleanup(patch.stop)

    def test_capture_replay_preserves_evidence_outcomes_and_corrections(self):
        data = export()
        first = opencode.capture(data)
        self.assertEqual(first['status'], 'queued')
        self.assertEqual(opencode.capture(data)['status'], 'unchanged')
        self.assertEqual(json.loads(Path(first['source']).read_text()), data)
        self.assertEqual(Path(first['source']).stat().st_mode & 0o777, 0o600)
        events = list(queue_manager.read_all_events())
        self.assertEqual([e.event for e in events], ['UserPromptSubmit', 'Stop'])
        self.assertEqual(events[0].data['import_source'], 'opencode')
        transcript = read_transcript(events[0].transcript_path)
        self.assertEqual(transcript.user_prompts, ['Keep the existing cache.', 'Correction: keep the new cache instead.'])
        self.assertEqual([t.success for t in transcript.tool_uses], [False, None])
        self.assertEqual(transcript.tool_uses[0].output, 'failure')
        self.assertIn('/synthetic/cache', transcript.files_touched)
        self.assertEqual(provenance.assistant_for(events[0].transcript_path), 'opencode')
        self.assertTrue(all(e.origin_source == 'opencode:ses_test' for e in transcript.source_events))
        self.assertIn(first['source'], transcript.context_sources)

    def test_new_turn_publishes_another_revision_without_duplicate_replay(self):
        data = export()
        opencode.capture(data)
        data['messages'][1]['parts'][0]['text'] = 'Updated response.'
        self.assertEqual(opencode.capture(data)['status'], 'queued')
        self.assertEqual(opencode.capture(data)['status'], 'unchanged')
        self.assertEqual(len(list(queue_manager.read_all_events())), 4)

    def test_subagents_and_incomplete_conversations_are_not_queued(self):
        for payload in (dict(export(), info=dict(export()['info'], parentID='parent')),
                        dict(export(), messages=export()['messages'][:1])):
            self.assertEqual(opencode.capture(payload)['status'], 'skipped')
        self.assertFalse((self.root / 'queue').exists())

    def test_wrong_session_malformed_parts_and_unknown_outcomes_fail_closed(self):
        for edit in ('session', 'message', 'duplicate', 'state'):
            data = export()
            if edit == 'session': data['messages'][0]['info']['sessionID'] = 'other'
            if edit == 'message': data['messages'][0]['parts'][0]['messageID'] = 'other'
            if edit == 'duplicate': data['messages'][2]['info']['id'] = 'u1'
            if edit == 'state': data['messages'][1]['parts'][1]['state']['status'] = 'unrecognized'
            with self.subTest(edit=edit), self.assertRaises(ValueError):
                opencode.capture(data)
        self.assertFalse((self.root / 'queue').exists())

    def test_tool_errors_and_success_are_explicit(self):
        data = export()
        state = data['messages'][1]['parts'][1]['state']
        state.update(status='error', error='synthetic tool error')
        tools = opencode.normalize(data)[1][1]['tools']
        self.assertTrue(tools[0]['is_error'])
        self.assertNotIn('exit_code', tools[1])
        state.update(status='completed', metadata={'exit': 0})
        self.assertEqual(opencode.normalize(data)[1][1]['tools'][0]['exit_code'], 0)

    def test_capture_does_not_grant_model_egress(self):
        source = opencode.capture(export())['source']
        with self.assertRaises(egress.EgressDenied):
            egress.prepare('synthetic', audience='model', sources=[source])

    def test_oversized_export_is_not_partially_published(self):
        data = export()
        data['messages'][0]['parts'][0]['text'] = 'x' * (opencode.MAX_EXPORT_BYTES + 1)
        with self.assertRaises(ValueError): opencode.capture(data)
        self.assertFalse((self.root / 'queue').exists())

    def test_installer_is_idempotent_quotes_command_and_preserves_other_plugins(self):
        folder = self.root / 'plugins'
        target = opencode.install_plugin(folder, '/synthetic/with spaces/claude-note')
        before = target.read_bytes()
        self.assertIn(b'"/synthetic/with spaces/claude-note"', before)
        opencode.install_plugin(folder, '/synthetic/with spaces/claude-note')
        self.assertEqual(target.read_bytes(), before)
        target.write_text('// authored plugin\n')
        with self.assertRaises(ValueError): opencode.install_plugin(folder, '/synthetic/tool')
        self.assertEqual(target.read_text(), '// authored plugin\n')

    def test_installer_dry_run_and_symlink_rejection(self):
        folder = self.root / 'plugins'
        target = opencode.install_plugin(folder, '/synthetic/tool', dry_run=True)
        self.assertFalse(folder.exists())
        folder.mkdir()
        target.symlink_to(self.root / 'elsewhere')
        with self.assertRaises(ValueError): opencode.install_plugin(folder, '/synthetic/tool')


if __name__ == '__main__':
    unittest.main()
