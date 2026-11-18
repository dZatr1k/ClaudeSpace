"""cclib: transcript parsing, titles, project folder, sampled reads, tail, aliases, archive."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
from cclib import chats, paths, projects  # noqa: E402
from tests import fixtures as fx  # noqa: E402


class ChatsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fh = fx.FakeHome()
        for k in ('XDG_CACHE_HOME', 'XDG_STATE_HOME'):
            os.environ.pop(k, None)
        paths.reset(cls.fh.home)

    @classmethod
    def tearDownClass(cls):
        cls.fh.cleanup()
        paths.reset()

    def setUp(self):
        chats.reset_memory()

    def by_id(self):
        return {c['sid']: c for c in chats.load_index()}

    def test_titles_priority(self):
        idx = self.by_id()
        self.assertEqual(chats.pick_title(idx[fx.ID_AI], {}), ('Починка сборки', 'ai'))
        self.assertEqual(chats.pick_title(idx[fx.ID_CUSTOM], {}), ('Моё название', 'custom'))
        self.assertEqual(chats.pick_title(idx[fx.ID_SUMMARY], {}), ('Резюме чата', 'summary'))
        self.assertEqual(chats.pick_title(idx[fx.ID_CD], {}), ('"cd sub"', 'prompt'))
        # alias beats ai/summary/prompt but not the user's own /rename (custom-title)
        self.assertEqual(chats.pick_title(idx[fx.ID_AI], {fx.ID_AI: 'Псевдоним'}), ('Псевдоним', 'alias'))
        self.assertEqual(chats.pick_title(idx[fx.ID_CUSTOM], {fx.ID_CUSTOM: 'X'})[1], 'custom')

    def test_prompts_and_noise(self):
        c = self.by_id()[fx.ID_AI]
        self.assertEqual(c['prompts'], 1)                  # the <command-name> line is noise
        self.assertEqual(c['prompt'], 'почини сборку')
        self.assertEqual((c['added'], c['removed']), (12, 3))
        self.assertEqual(c['branch'], 'main')

    def test_project_from_dir_name_not_cd(self):
        c = self.by_id()[fx.ID_CD]
        self.assertEqual(c['cwd'], self.fh.alpha)

    def test_big_file_sampled(self):
        c = self.by_id()[fx.ID_BIG]
        self.assertGreater(c['size'], 2 * 1024 * 1024)
        self.assertTrue(c['sampled'])
        self.assertEqual(c['title'], 'Большой чат')        # from the tail
        self.assertEqual(c['prompt'], 'большой чат: начало')   # from the head
        self.assertLess(c['prompts'], 3001)
        m = chats.to_model(c)
        self.assertTrue(m['promptsApprox'])

    def test_visible_and_archived(self):
        idx = self.by_id()
        self.assertTrue(idx[fx.ID_ARCH]['archived'])
        self.assertFalse(idx[fx.ID_AI]['archived'])
        vis = {c['sid'] for c in chats.visible(idx.values())}
        self.assertNotIn(fx.ID_EMPTY, vis)

    def test_index_cache_reused(self):
        chats.load_index()
        self.assertTrue(os.path.exists(paths.P.index))
        chats.reset_memory()
        before = self.by_id()[fx.ID_AI]
        self.assertEqual(before['title'], 'Починка сборки')

    def test_model_shape(self):
        m = chats.to_model(self.by_id()[fx.ID_AI])
        for k in ('id', 'project', 'title', 'titleSource', 'firstPrompt', 'prompts', 'promptsApprox', 'branch',
                  'linesAdded', 'linesRemoved', 'firstAt', 'lastAt', 'sizeBytes', 'claudeVersion', 'archived',
                  'open'):
            self.assertIn(k, m)
        from datetime import datetime, timezone
        self.assertEqual(m['firstAt'], int(datetime(2026, 11, 1, 10, tzinfo=timezone.utc).timestamp() * 1000))

    def test_tail(self):
        tail = chats.tail_dialog(self.by_id()[fx.ID_AI]['path'], 6)
        self.assertEqual([t['role'] for t in tail], ['user', 'assistant'])
        self.assertEqual(tail[1]['text'], 'Готово, собрал.')

    def test_tail_info(self):
        # plain chat: last real prompt (not the <command-name> noise), no model without assistant usage
        ti = chats.tail_info(self.by_id()[fx.ID_AI]['path'])
        self.assertEqual(ti['lastPrompt']['text'], 'почини сборку')
        self.assertEqual(ti['lastPrompt']['at'], 1793527201000)   # 2026-11-01T10:00:01Z
        self.assertIsNone(ti['context'])
        # model + usage of the last main-chain assistant message; tool results, sidechains, <synthetic> skipped
        p = os.path.join(self.fh.home, 'tail-info.jsonl')
        a = self.fh.alpha

        def asst(model, usage, **kw):
            return fx.line(type='assistant', message={'role': 'assistant', 'model': model, 'usage': usage,
                                                      'content': [{'type': 'text', 'text': 'ok'}]},
                           timestamp='2026-11-08T12:00:05Z', **kw)
        with open(p, 'w') as f:
            f.write(fx.user('старый запрос', '2026-11-08T11:00:00Z', a, fx.ID_AI))
            f.write(fx.user('последний запрос\nвторая строка', '2026-11-08T12:00:00Z', a, fx.ID_AI))
            f.write(asst('claude-opus-4-5-20251101', {'input_tokens': 10, 'cache_creation_input_tokens': 2000,
                                                       'cache_read_input_tokens': 40000, 'output_tokens': 300}))
            f.write(fx.line(type='user', message={'role': 'user', 'content': [
                {'type': 'tool_result', 'content': 'x'}]}, timestamp='2026-11-08T12:00:06Z'))
            f.write(asst('claude-haiku-4-5', {'input_tokens': 1}, isSidechain=True))
            f.write(asst('<synthetic>', {'input_tokens': 0}))
            # > 256 KB after the prompt: the second, larger step still finds it
            for _ in range(400):
                f.write(fx.line(type='progress', data='y' * 1000))
        ti = chats.tail_info(p)
        self.assertEqual(ti['lastPrompt'], {'text': 'последний запрос\nвторая строка', 'at': 1794139200000})
        self.assertEqual(ti['model'], 'claude-opus-4-5-20251101')
        self.assertEqual(ti['context'], {'tokens': 42010, 'output': 300})
        # huge file: only the tail is read, prompt truncated
        big = chats.tail_info(self.by_id()[fx.ID_BIG]['path'], max_chars=50)
        self.assertTrue(big['lastPrompt']['text'].startswith('запрос 2999 '))
        self.assertEqual(len(big['lastPrompt']['text']), 50)
        self.assertEqual(chats.tail_info(os.path.join(self.fh.home, 'nope.jsonl'))['lastPrompt'], None)

    def test_aliases(self):
        chats.set_title(fx.ID_SUMMARY, 'Новое имя')
        self.assertEqual(chats.load_titles()[fx.ID_SUMMARY], 'Новое имя')
        chats.set_title(fx.ID_SUMMARY, None)
        self.assertNotIn(fx.ID_SUMMARY, chats.load_titles())

    def test_archive_restore_and_open_refusal(self):
        with self.assertRaises(chats.MoveError) as e:
            chats.move_chat(fx.ID_SUMMARY, True, lambda sid: True)
        self.assertEqual(e.exception.code, 'chat_open')
        c = chats.move_chat(fx.ID_SUMMARY, True, lambda sid: False)
        self.assertTrue(c['archived'])
        self.assertTrue(c['path'].startswith(paths.P.archive_dir))
        with self.assertRaises(chats.MoveError) as e:
            chats.move_chat(fx.ID_SUMMARY, True, lambda sid: False)
        self.assertEqual(e.exception.code, 'exists')
        c = chats.move_chat(fx.ID_SUMMARY, False, lambda sid: False)
        self.assertFalse(c['archived'])
        with self.assertRaises(chats.MoveError) as e:
            chats.move_chat('00000000-0000-4000-8000-000000000000', True, lambda sid: False)
        self.assertEqual(e.exception.code, 'not_found')

    def test_projects(self):
        every = [c for c in chats.load_index() if not c.get('archived')]
        dirs = [d for d, _ in projects.project_dirs(every)[0]]
        self.assertIn(self.fh.alpha, dirs)
        self.assertIn(self.fh.beta, dirs)
        self.assertIn(self.fh.home, dirs)
        built = {p['path']: p for p in projects.build(every, {self.fh.alpha: ('Alpha', 'busy')})}
        a = built[self.fh.alpha]
        self.assertEqual(a['name'], 'Alpha')
        self.assertEqual(a['git']['branch'], 'main')
        self.assertTrue(a['git']['dirty'])                # CLAUDE.md is untracked
        self.assertEqual((a['liveSession'], a['liveStatus']), ('Alpha', 'busy'))
        self.assertEqual(built[self.fh.home]['name'], 'home')
        self.assertIsNone(built[self.fh.beta]['git'])

    def test_create_project(self):
        rp = projects.create_project(os.path.join(self.fh.home, 'projects', 'Gamma'), True)
        self.assertTrue(os.path.isdir(os.path.join(rp, '.git')))
        for bad, code in (('/tmp/x-outside', 'not_allowed'), (self.fh.home, 'not_allowed'),
                          (rp, 'exists'), (os.path.join(self.fh.home, 'projects', '..', '..', 'esc'), 'not_allowed')):
            with self.assertRaises(ValueError) as e:
                projects.create_project(bad)
            self.assertEqual(e.exception.args[0], code, bad)

    def test_created_project_outside_projects_root_is_listed(self):
        # a folder right in ~ with no chat yet: before, it was made but never shown in the list
        rp = projects.create_project('~/Epsilon')
        self.assertEqual(rp, os.path.join(self.fh.home, 'Epsilon'))
        dirs = [d for d, _ in projects.project_dirs([])[0]]
        self.assertIn(rp, dirs)
        self.assertEqual(projects.display_name(rp), 'home/Epsilon')
        os.rmdir(rp)
        self.assertNotIn(rp, [d for d, _ in projects.project_dirs([])[0]])
        projects.create_project('~/Zeta')                 # a deleted folder is dropped from the file on the next save
        self.assertEqual(projects.created_dirs()[-1], os.path.join(self.fh.home, 'Zeta'))
        self.assertNotIn(rp, projects.created_dirs())
        os.rmdir(os.path.join(self.fh.home, 'Zeta'))

    def test_created_list_ignores_bad_entries(self):
        paths.atomic_write_json(projects.created_file(), ['/etc', os.path.join(self.fh.home, '.ssh'), 42])
        dirs = [d for d, _ in projects.project_dirs([])[0]]
        self.assertNotIn('/etc', dirs)
        self.assertNotIn(os.path.join(self.fh.home, '.ssh'), dirs)
        with open(projects.created_file(), 'w') as f:
            f.write('{not json')
        self.assertEqual(projects.created_dirs(), [])
        os.remove(projects.created_file())

    def test_not_allowed_names_real_home(self):
        home = self.fh.home
        with self.assertRaises(ValueError) as e:
            projects.create_project('/home/x-outside-name')
        self.assertIn(f'{home}/projects/x-outside-name', e.exception.args[1])
        with self.assertRaises(ValueError) as e:
            projects.create_project(home)
        self.assertIn('home', e.exception.args[1])
        with self.assertRaises(ValueError) as e:
            projects.create_project(os.path.join(home, '.ssh', 'p'))
        self.assertIn('ключами', e.exception.args[1])


if __name__ == '__main__':
    unittest.main()
