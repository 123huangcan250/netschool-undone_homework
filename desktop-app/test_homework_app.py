import importlib.machinery
import importlib.util
from pathlib import Path
import json
import tempfile
import unittest
from unittest.mock import Mock, patch

loader = importlib.machinery.SourceFileLoader('homework_app', str(Path(__file__).with_name('homework_app.pyw')))
spec = importlib.util.spec_from_loader(loader.name, loader)
app = importlib.util.module_from_spec(spec)
loader.exec_module(app)


def homework(id, deadline=None, course='one', status='unsubmitted'):
    return dict(homeworkId=id, courseId=course, deadline=deadline, title=id, status=status)


class DashboardTests(unittest.TestCase):
    def test_delete_persists_across_refresh_and_restore_keeps_course_identity(self):
        with tempfile.TemporaryDirectory(prefix='thu-homework-ui-') as directory:
            root = Path(directory).resolve()
            window = app.tk.Tk()
            window.withdraw()
            try:
                (root / 'app-settings.json').write_text(json.dumps({'refreshSeconds': 3600}), encoding='utf-8')
                (root / 'data').mkdir()
                first = dict(homework('same-id', course='one'), courseName='课程甲', descriptionText='完成电路设计，并提交实验报告。', contentFetchedAt='2030-01-01T00:00:00Z')
                second = dict(homework('same-id', course='two'), courseName='课程乙', descriptionText='阅读第二章。', contentFetchedAt='2030-01-01T00:00:00Z')
                result = dict(event='result', semesterId='2030-2031-1', courses=[{'courseId': 'one'}, {'courseId': 'two'}],
                              completedCourseIds=['one', 'two'], homeworks=[first, second], errors=[], fetchedAt='2030-01-01T00:00:00Z')
                (root / 'data' / 'cache.json').write_text(json.dumps(result), encoding='utf-8')
                with patch.object(app, 'ROOT', root):
                    instance = app.HomeworkApp(window)
                    for timer in window.tk.call('after', 'info'):
                        window.after_cancel(timer)
                    window.update_idletasks()
                    key = app.homework_key(first)
                    self.assertEqual(instance.table.set(key, 'course'), '课程甲')
                    self.assertIn('电路设计', instance.table.set(key, 'summary'))
                    instance.table.selection_set(key)
                    instance.selection_changed()
                    self.assertIn('提交实验报告', instance.content.get('1.0', 'end'))
                    instance.delete_button.invoke()
                    stored = json.loads(instance.hidden_path.read_text(encoding='utf-8'))
                    self.assertIn(key, stored)
                    self.assertNotIn(key, instance.rows)
                    self.assertIn(app.homework_key(second), instance.rows)
                    instance.events.put(result)
                    instance.poll()
                    self.assertNotIn(key, instance.rows)
                    # A restart reloads the same persisted filter.
                    self.assertEqual(len(app.visible_homeworks(result['homeworks'], stored)), 1)
                    instance.restore_hidden([key])
                    self.assertIn(key, instance.rows)
                    self.assertEqual(json.loads(instance.hidden_path.read_text(encoding='utf-8')), {})
                    instance.events.put({'event': 'error', 'code': 'AUTH_REQUIRED', 'message': '请重新登录。'})
                    instance.poll()
                    instance.render()
                    self.assertIn('登录已失效', instance.coverage.cget('text'))
                    self.assertIn('缓存', instance.coverage.cget('text'))
                    self.assertIn('AUTH_REQUIRED', instance.status.cget('text'))
                    self.assertIn(key, instance.rows)
                    self.assertTrue(instance.table.bind('<Delete>'))
                    instance.table.selection_set(key)
                    self.assertEqual(instance.delete_key(), 'break')
                    self.assertNotIn(key, instance.rows)
                    instance.restore_hidden([key])
            finally:
                window.destroy()
                if root.parent != Path(tempfile.gettempdir()).resolve() or not root.name.startswith('thu-homework-ui-'):
                    raise RuntimeError('Unsafe temporary cleanup target')

    def test_controls_remain_inside_window_at_different_sizes_and_font_scales(self):
        with tempfile.TemporaryDirectory(prefix='thu-homework-ui-') as directory:
            root = Path(directory).resolve()
            try:
                (root / 'app-settings.json').write_text(json.dumps({'refreshSeconds': 3600}), encoding='utf-8')
                for scale in (1.333, 1.667, 2.0):
                    window = app.tk.Tk()
                    window.withdraw()
                    window.tk.call('tk', 'scaling', scale)
                    try:
                        with patch.object(app, 'ROOT', root):
                            instance = app.HomeworkApp(window)
                        for timer in window.tk.call('after', 'info'):
                            window.after_cancel(timer)
                        # A withdrawn Tk root doesn't allocate child geometry. Map the
                        # test-owned window transparently to exercise the real layout.
                        window.attributes('-alpha', 0.0)
                        window.deiconify()
                        window.update()
                        for width, height in ((1000, 700), (1320, 900), (1536, 790)):
                            window.geometry(f'{width}x{height}')
                            window.update()
                            for label, widget in [('delete', instance.delete_button), ('restore list', instance.hidden_button),
                                                  ('description', instance.content), ('browser login', instance.login_button)]:
                                bounds = instance.widget_bounds(widget)
                                self.assertTrue(bounds['insideWindow'], f'{label} scale={scale} size={width}x{height}: {bounds}; root={window.winfo_width()}x{window.winfo_height()}')
                            self.assertLess(instance.widget_bounds(instance.delete_button)['y'], instance.widget_bounds(instance.table)['y'])
                        instance.show_hidden()
                        instance.hidden_window.attributes('-alpha', 0.0)
                        window.update()
                        dialog = instance.hidden_window
                        restore = instance.restore_button
                        self.assertGreater(restore.winfo_height(), 1)
                        self.assertLessEqual(restore.winfo_rooty() + restore.winfo_height(), dialog.winfo_rooty() + dialog.winfo_height())
                    finally:
                        window.destroy()
            finally:
                if root.parent != Path(tempfile.gettempdir()).resolve() or not root.name.startswith('thu-homework-ui-'):
                    raise RuntimeError('Unsafe temporary cleanup target')

    def test_content_failure_preserves_cached_body_but_updates_deadline(self):
        old = dict(homework('a', '2029-01-01T00:00:00Z'), descriptionText='旧正文', contentFetchedAt='2029-01-01T00:00:00Z')
        updated = dict(homework('a', '2030-01-01T00:00:00Z'), contentStatus='failed')
        result = dict(courses=[{'courseId': 'one'}], completedCourseIds=['one'], homeworks=[updated])
        merged = app.merge_snapshot({'homeworks': [old]}, result)['homeworks'][0]
        self.assertEqual(merged['descriptionText'], '旧正文')
        self.assertEqual(merged['deadline'], updated['deadline'])
        self.assertEqual(merged['contentStatus'], 'stale')

    def test_attachment_only_content_is_not_mistaken_for_missing_description(self):
        item = dict(homework('a'), descriptionText='', assignmentAttachments=[{'name': '题目.pdf'}], contentFetchedAt='2030-01-01T00:00:00Z')
        self.assertEqual(app.content_summary(item), '附件：题目.pdf')

    def test_hourly_timer_and_no_overlapping_refresh(self):
        # Advance a clock across two hours without real network or a one-hour sleep.
        instance = object.__new__(app.HomeworkApp)
        instance.busy, instance.closing = False, False
        instance.editing_credentials = False
        instance.login_busy, instance.checking_session, instance.auto_session_enabled = False, False, False
        instance.interval, instance.next_refresh, instance.last_health = 3600, 4600, 4600
        instance.rows = {}
        instance.window = Mock()
        instance.countdown = Mock()
        instance.refresh_button = Mock()
        instance.progress = Mock()
        instance.status = Mock()
        instance.write_health = Mock()
        instance.render = Mock()
        with patch.object(app.time, 'monotonic') as clock, patch.object(app.threading, 'Thread') as worker:
            clock.return_value = 4599
            instance.tick()
            worker.assert_not_called()
            clock.return_value = 4600
            instance.tick()
            self.assertEqual(instance.next_refresh, 8200)
            self.assertEqual(worker.call_count, 1)
            instance.tick()
            self.assertEqual(worker.call_count, 1)
            instance.busy = False
            clock.return_value = 8200
            instance.tick()
            self.assertEqual(worker.call_count, 2)
            self.assertEqual(instance.next_refresh, 11800)

    def test_login_success_schedules_refresh_and_blocks_overlapping_workers(self):
        instance = object.__new__(app.HomeworkApp)
        instance.busy, instance.closing, instance.login_busy = False, False, False
        instance.login_button, instance.refresh_button, instance.status = Mock(), Mock(), Mock()
        instance.window = Mock()
        instance.events = app.queue.Queue()
        with patch.object(app.threading, 'Thread') as worker:
            instance.browser_login()
            self.assertTrue(instance.login_busy)
            instance.refresh()
            self.assertEqual(worker.call_count, 1)
        instance.events.put({'event': 'loginComplete'})
        instance.events.put({'event': 'loginFinished'})
        instance.poll()
        self.assertFalse(instance.login_busy)
        self.assertTrue(instance.auto_session_enabled)
        self.assertTrue(any(call.args == (1500, instance.refresh) for call in instance.window.after.call_args_list))

    def test_ten_minute_session_check_preserves_hourly_homework_schedule(self):
        instance = object.__new__(app.HomeworkApp)
        instance.busy, instance.closing, instance.login_busy = False, False, False
        instance.editing_credentials = False
        instance.next_refresh = 10000
        instance.status, instance.refresh_button = Mock(), Mock()
        with patch.object(app.time, 'monotonic', return_value=2000), patch.object(app.threading, 'Thread') as worker:
            instance.check_session()
            self.assertTrue(instance.checking_session)
            self.assertEqual(instance.next_session_check, 2600)
            self.assertEqual(instance.next_refresh, 10000)
            self.assertEqual(worker.call_args.kwargs['args'], (True,))
            instance.check_session()
            self.assertEqual(worker.call_count, 1)

    def test_order_dedup_unknown_and_submitted(self):
        values = [homework('unknown'), homework('later', '2030-02-01T00:00:00Z'),
                  homework('expired', '2020-01-01T00:00:00Z'), homework('later', '2030-02-01T00:00:00Z'),
                  homework('submitted', '2020-01-01T00:00:00Z', status='submitted'),
                  homework('earlier', '2030-01-01T08:00:00+08:00')]
        self.assertEqual([h['homeworkId'] for h in app.sorted_homeworks(values)], ['expired', 'earlier', 'later', 'unknown'])

    def test_partial_failure_retains_only_failed_current_course(self):
        previous = {'homeworks': [homework('now-submitted'), homework('keep', course='failed'), homework('old-semester', course='old')]}
        result = {'courses': [{'courseId': 'one'}, {'courseId': 'failed'}],
                  'completedCourseIds': ['one'], 'homeworks': [homework('new')]}
        merged = app.merge_snapshot(previous, result)
        self.assertEqual({h['homeworkId'] for h in merged['homeworks']}, {'new', 'keep'})
        self.assertTrue(next(h for h in merged['homeworks'] if h['homeworkId'] == 'keep')['stale'])

    def test_remaining_uses_deadline_not_cached_counter(self):
        h = homework('test', '2030-01-01T00:01:00Z')
        deadline = app.deadline_seconds(h)
        self.assertEqual(app.remaining_text(h, deadline - 60), '剩余 1 分钟')
        self.assertEqual(app.remaining_text(h, deadline + 60), '已逾期 1 分钟')
        self.assertEqual(app.remaining_text(homework('unknown'), deadline), '截止时间未知')


if __name__ == '__main__':
    unittest.main()
