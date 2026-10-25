"""Always-open, hourly, read-only homework dashboard. Python standard library only."""
import json
import math
import os
from pathlib import Path
import queue
import re
import subprocess
import sys
import threading
import time
import tkinter as tk
from tkinter import messagebox, simpledialog, ttk
from datetime import datetime, timezone, timedelta
import webbrowser

ROOT = Path(__file__).resolve().parent
BEIJING = timezone(timedelta(hours=8))
BG, INK, MUTED, PAPER, ACCENT = '#F3F1EB', '#202D2A', '#69756D', '#FFFFFF', '#235D4D'


def deadline_seconds(item):
    try:
        value = datetime.fromisoformat(item['deadline'].replace('Z', '+00:00'))
        if value.tzinfo is None:
            return math.inf
        return value.timestamp()
    except (KeyError, TypeError, ValueError, AttributeError):
        return math.inf


def sorted_homeworks(items):
    unique = {}
    for item in items:
        if item.get('status') == 'unsubmitted':
            unique[(item['courseId'], item['homeworkId'])] = item
    return sorted(unique.values(), key=lambda h: (deadline_seconds(h), h.get('courseName', ''), h['title']))


def homework_key(item):
    return f"{item['courseId']}:{item['homeworkId']}"


def visible_homeworks(items, hidden):
    return [h for h in sorted_homeworks(items) if homework_key(h) not in hidden]


def content_summary(item):
    text = re.sub(r'\s+', ' ', item.get('descriptionText', '')).strip()
    if not text:
        attachments = item.get('assignmentAttachments', [])
        text = '附件：' + '、'.join(a['name'] for a in attachments) if attachments else (
            '内容读取失败，请打开原网页' if item.get('contentStatus') == 'failed' else
            '老师未填写文字说明' if item.get('contentFetchedAt') else '正在读取主要内容…')
    return text[:96] + ('…' if len(text) > 96 else '')


def merge_snapshot(previous, result):
    """Replace successful courses; retain failed courses explicitly marked as stale."""
    current = {c['courseId'] for c in result['courses']}
    completed = set(result['completedCourseIds'])
    retained = [dict(h, stale=True) for h in previous.get('homeworks', [])
                if h['courseId'] in current and h['courseId'] not in completed]
    old = {homework_key(h): h for h in previous.get('homeworks', [])}
    fresh = []
    for item in result['homeworks']:
        item = dict(item, stale=False)
        cached = old.get(homework_key(item), {})
        if 'descriptionText' not in item and 'descriptionText' in cached:
            for field in ('descriptionText', 'assignmentAttachments', 'contentFetchedAt'):
                if field in cached:
                    item[field] = cached[field]
            item['contentStatus'] = 'stale' if item.get('contentStatus') == 'failed' else 'cached'
        fresh.append(item)
    return dict(result, homeworks=sorted_homeworks(fresh + retained))


def remaining_text(item, now):
    deadline = deadline_seconds(item)
    if not math.isfinite(deadline):
        return '截止时间未知'
    seconds = deadline - now
    minutes = max(1, math.ceil(abs(seconds) / 60))
    days, rest = divmod(minutes, 1440)
    hours, mins = divmod(rest, 60)
    value = f'{days} 天 {hours} 小时' if days else (f'{hours} 小时 {mins} 分' if hours else f'{mins} 分钟')
    return ('已逾期 ' if seconds <= 0 else '剩余 ') + value


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    os.replace(temporary, path)


class HomeworkApp:
    def __init__(self, window):
        self.window = window
        self.settings_path = ROOT / 'app-settings.json'
        self.settings = json.loads(self.settings_path.read_text(encoding='utf-8-sig'))
        self.interval = max(3600, int(self.settings.get('refreshSeconds', 3600)))
        self.data_dir = ROOT / 'data'
        self.cache_path = self.data_dir / 'cache.json'
        self.hidden_path = self.data_dir / 'hidden.json'
        self.hidden = {}
        try:
            self.hidden = json.loads(self.hidden_path.read_text(encoding='utf-8'))
            if not isinstance(self.hidden, dict):
                raise ValueError('Invalid local hidden list')
        except FileNotFoundError:
            pass
        self.hidden_window = None
        self.detail_signature = object()
        self.events = queue.Queue()
        self.snapshot = {}
        self.busy = False
        self.process = None
        self.login_process = None
        self.login_busy = False
        self.login_succeeded = False
        self.checking_session = False
        self.session_checked_at = None
        self.session_refresh_needed = False
        self.session_warning = ''
        self.next_session_check = time.monotonic() + 600
        self.auto_session_enabled = False
        try:
            self.auto_session_enabled = json.loads((self.data_dir / 'browser-session.json').read_text(encoding='utf-8')).get('enabled') is True
        except (OSError, ValueError):
            pass
        self.closing = False
        self.last_error = ''
        self.data_state = 'cached'
        self.next_refresh = time.monotonic()
        self.last_health = 0
        self.rows = {}
        try:
            cached = json.loads(self.cache_path.read_text(encoding='utf-8'))
            if isinstance(cached.get('homeworks'), list):
                self.snapshot = cached
        except (OSError, ValueError):
            pass
        self.build_ui()
        self.render()
        window.protocol('WM_DELETE_WINDOW', self.minimize)
        window.after(100, self.poll)
        window.after(1000, self.tick)
        window.after(250, self.refresh)

    def build_ui(self):
        w = self.window
        w.title('作业列表')
        width = min(1320, w.winfo_screenwidth() - 80)
        height = min(900, w.winfo_screenheight() - 120)
        w.geometry(f'{width}x{height}')
        w.minsize(1000, 700)
        w.configure(bg=BG)
        w.option_add('*Font', ('Microsoft YaHei UI', 10))
        style = ttk.Style(w)
        style.theme_use('clam')
        style.configure('Treeview', background=PAPER, fieldbackground=PAPER, foreground=INK,
                        font=('Microsoft YaHei UI', 10), rowheight=46, borderwidth=0)
        style.configure('Treeview.Heading', background='#E4E9E3', foreground=MUTED,
                        font=('Microsoft YaHei UI', 10), padding=(12, 12), relief='flat')
        style.map('Treeview', background=[('selected', '#D6E7DF')], foreground=[('selected', INK)])
        style.configure('TProgressbar', background=ACCENT, troughcolor='#E0E5DD', borderwidth=0)

        header = tk.Frame(w, bg=INK, padx=24, pady=14)
        header.pack(fill='x')
        tk.Label(header, text='作业列表', font=('Microsoft YaHei UI', 24, 'bold'), bg=INK, fg='#FAFBF5').pack(side='left')
        right = tk.Frame(header, bg=INK)
        right.pack(side='right')
        self.countdown = tk.Label(right, text='每小时自动刷新', bg=INK, fg='#CFDCD4', font=('Consolas', 11))
        self.countdown.pack(anchor='e', pady=(0, 8))
        self.refresh_button = tk.Button(right, text='立即刷新', command=self.refresh, bg='#DDE6C7', fg=INK,
                                        activebackground='#EDF2E3', relief='flat', padx=18, pady=7, cursor='hand2')
        self.refresh_button.pack(anchor='e')

        body = tk.Frame(w, bg=BG, padx=24, pady=12)
        body.pack(fill='both', expand=True)
        body.columnconfigure(0, weight=1)
        # Reserve controls first; only the table and description consume spare height.
        # Packing a default-height Treeview before the controls hid the entire footer
        # on shorter screens / Windows display scaling.
        body.rowconfigure(4, weight=3, minsize=100)
        body.rowconfigure(6, weight=1, minsize=80)
        stats = tk.Frame(body, bg=BG)
        stats.grid(row=0, column=0, sticky='ew', pady=(0, 8))
        self.stats = []
        for label, color in [('待处理作业', ACCENT), ('24 小时内截止', '#9B5B13'), ('已逾期', '#B24736')]:
            box = tk.Frame(stats, bg=BG)
            box.pack(side='left', padx=(0, 48))
            number = tk.Label(box, text='—', bg=BG, fg=color, font=('Consolas', 25, 'bold'))
            number.pack(side='left')
            tk.Label(box, text=label, bg=BG, fg=MUTED).pack(side='left', padx=10)
            self.stats.append(number)
        self.coverage = tk.Label(body, text='正在连接网络学堂……', bg=BG, fg=MUTED, anchor='w')
        self.coverage.grid(row=1, column=0, sticky='ew', pady=(0, 6))
        self.progress = ttk.Progressbar(body, mode='determinate', maximum=1, value=0)
        self.progress.grid(row=2, column=0, sticky='ew', pady=(0, 8))

        toolbar = tk.Frame(body, bg=BG)
        toolbar.grid(row=3, column=0, sticky='ew', pady=(0, 10))
        self.delete_button = tk.Button(toolbar, text='删除选中作业（Delete）', command=self.hide_selected,
                                        bg='#B24736', fg=PAPER, activebackground='#913A2C', activeforeground=PAPER,
                                        relief='flat', padx=16, pady=7, cursor='hand2')
        self.delete_button.pack(side='left')
        self.hidden_button = tk.Button(toolbar, text='已删除（0）', command=self.show_hidden,
                                        bg='#E4E9E3', fg=INK, relief='flat', padx=14, pady=7, cursor='hand2')
        self.hidden_button.pack(side='left', padx=10)
        self.open_button = tk.Button(toolbar, text='打开选中作业 ↗', command=self.open_homework,
                                     bg=BG, fg=ACCENT, relief='flat', padx=14, pady=7, cursor='hand2')
        self.open_button.pack(side='left')

        table_frame = tk.Frame(body, bg=PAPER)
        table_frame.grid(row=4, column=0, sticky='nsew')
        columns = ('course', 'title', 'summary', 'deadline', 'remaining')
        self.table = ttk.Treeview(table_frame, columns=columns, show='headings', selectmode='browse', height=4)
        for key, label, width in [('course', '所属课程', 185), ('title', '作业名称', 260),
                                  ('summary', '主要内容 · 选中查看完整说明', 360),
                                  ('deadline', '截止 · 北京时间', 150), ('remaining', '剩余时间 ↑', 195)]:
            self.table.heading(key, text=label, anchor='w')
            self.table.column(key, width=width, minwidth=110, anchor='w', stretch=True)
        scrollbar = ttk.Scrollbar(table_frame, orient='vertical', command=self.table.yview)
        self.table.configure(yscrollcommand=scrollbar.set)
        scrollbar.pack(side='right', fill='y')
        self.table.pack(side='left', fill='both', expand=True)
        self.table.tag_configure('overdue', foreground='#B24736', background='#FFF4EF')
        self.table.tag_configure('urgent', foreground='#91510C', background='#FFF9EA')
        self.table.tag_configure('stale', foreground='#7B807C')
        self.table.bind('<<TreeviewSelect>>', self.selection_changed)
        self.table.bind('<Double-1>', lambda event: self.open_homework())
        self.table.bind('<Return>', lambda event: self.open_homework())
        self.table.bind('<Delete>', self.delete_key)
        self.selected = tk.Label(body, text='按截止时间升序排列；过期未交作业在最前，未知时间在末尾。',
                                 bg=BG, fg=MUTED, anchor='w', justify='left', wraplength=1060)
        self.selected.grid(row=5, column=0, sticky='ew', pady=(8, 4))
        detail_frame = tk.Frame(body, bg=PAPER)
        detail_frame.grid(row=6, column=0, sticky='nsew', pady=(0, 6))
        self.content = tk.Text(detail_frame, height=3, wrap='word', bg=PAPER, fg=INK, relief='flat',
                               padx=14, pady=12, font=('Microsoft YaHei UI', 10), state='disabled', cursor='arrow')
        content_scroll = ttk.Scrollbar(detail_frame, orient='vertical', command=self.content.yview)
        self.content.configure(yscrollcommand=content_scroll.set)
        content_scroll.pack(side='right', fill='y')
        self.content.pack(fill='both', expand=True)
        self.status = tk.Label(body, text='正在准备首次刷新……', bg=BG, fg=ACCENT, anchor='w', justify='left', wraplength=1060)
        self.status.grid(row=7, column=0, sticky='ew', pady=(2, 6))
        footer = tk.Frame(body, bg=BG)
        footer.grid(row=8, column=0, sticky='ew')
        self.login_button = tk.Button(footer, text='浏览器登录（自动同步）', command=self.browser_login, bg=BG, fg=ACCENT,
                                      relief='flat', padx=0, cursor='hand2')
        self.login_button.pack(side='left')
        tk.Button(footer, text='更新 Cookie', command=self.update_cookie, bg=BG, fg=MUTED,
                  relief='flat', padx=16, cursor='hand2').pack(side='left')
        tk.Button(footer, text='退出程序', command=self.exit, bg=BG, fg=MUTED,
                  relief='flat', padx=0, cursor='hand2').pack(side='right')
        self.action_note = tk.Label(body, text='删除仅在本地隐藏，可从“已删除”恢复。关闭窗口会最小化并继续刷新。',
                                    bg=BG, fg=MUTED, anchor='w')
        self.action_note.grid(row=9, column=0, sticky='ew', pady=(4, 0))
        body.bind('<Configure>', lambda event: self.resize_labels(event.width))

    def resize_labels(self, width):
        for label in (self.coverage, self.selected, self.status, self.action_note):
            label.configure(wraplength=max(400, width - 48))

    def delete_key(self, event=None):
        self.hide_selected()
        return 'break'

    def render(self):
        old_selection = self.table.selection()
        old_scroll = self.table.yview()[0]
        old_key = old_selection[0] if old_selection else None
        self.table.delete(*self.table.get_children())
        self.rows = {}
        now = time.time()
        items = visible_homeworks(self.snapshot.get('homeworks', []), self.hidden)
        for index, h in enumerate(items):
            key = homework_key(h)
            self.rows[key] = h
            deadline = deadline_seconds(h)
            date = datetime.fromtimestamp(deadline, BEIJING).strftime('%m-%d %H:%M') if math.isfinite(deadline) else '未提供'
            tags = ('stale',) if h.get('stale') else ('overdue',) if deadline <= now else ('urgent',) if deadline - now <= 86400 else ()
            title = ('【旧数据】' if h.get('stale') else '') + h['title']
            self.table.insert('', 'end', iid=key, values=(h.get('courseName', ''), title, content_summary(h), date, remaining_text(h, now)), tags=tags)
        if old_key in self.rows:
            self.table.selection_set(old_key)
        elif self.rows:
            self.table.selection_set(next(iter(self.rows)))
        self.table.yview_moveto(old_scroll)
        self.stats[0].configure(text=str(len(items)) if self.snapshot else '—')
        self.stats[1].configure(text=str(sum(0 < deadline_seconds(h) - now <= 86400 for h in items)))
        self.stats[2].configure(text=str(sum(deadline_seconds(h) <= now for h in items)))
        if self.snapshot:
            courses = self.snapshot.get('courses', [])
            completed = self.snapshot.get('completedCourseIds', [])
            current_hidden = len(sorted_homeworks(self.snapshot.get('homeworks', []))) - len(items)
            coverage = f"当前学期 {self.snapshot.get('semesterId', '')}  /  已核对 {len(completed)} / {len(courses)} 门课程  /  本地隐藏 {current_hidden} 项"
            if self.data_state in ('cached', 'refreshing', 'failed'):
                reason = '登录已失效，请点击“浏览器登录”' if self.last_error in ('AUTH_REQUIRED', 'CSRF_INVALID') else (
                    '正在刷新' if self.data_state == 'refreshing' else '本次刷新未完成')
                try:
                    stamp = datetime.fromisoformat(self.snapshot['fetchedAt'].replace('Z', '+00:00')).astimezone(BEIJING).strftime('%m-%d %H:%M')
                except (KeyError, ValueError, TypeError):
                    stamp = '未知时间'
                coverage = f'{reason}；当前显示 {stamp} 的缓存（北京时间）。  /  本地隐藏 {current_hidden} 项'
            self.coverage.configure(text=coverage)
        self.hidden_button.configure(text=f'已删除（{len(self.hidden)}）')
        self.selection_changed()

    def selection_changed(self, event=None):
        selection = self.table.selection()
        if selection and selection[0] in self.rows:
            h = self.rows[selection[0]]
            deadline = deadline_seconds(h)
            date = datetime.fromtimestamp(deadline, BEIJING).strftime('%Y-%m-%d %H:%M:%S') if math.isfinite(deadline) else '未知'
            self.selected.configure(text=f"{h.get('courseName', '')}  ·  {h['title']}\n截止时间：{date}（北京时间）" + ('  ·  此课程刷新失败，显示旧数据。' if h.get('stale') else ''))
            body = h.get('descriptionText', '').strip()
            if not body:
                body = '内容读取失败，请打开原网页查看。' if h.get('contentStatus') == 'failed' else (
                    '老师未填写文字说明，请查看附件或原网页。' if h.get('contentFetchedAt') else '正在读取作业主要内容，完成刷新后会自动显示。')
            names = [a['name'] for a in h.get('assignmentAttachments', [])]
            text = '主要内容\n' + body
            if names:
                text += '\n\n作业附件\n' + '\n'.join('• ' + name for name in names)
            if h.get('contentStatus') in ('stale', 'cached'):
                text += '\n\n（以上正文来自上次缓存；可打开原网页核对。）'
            self.set_content((selection[0], text), text)
            self.delete_button.configure(state='normal')
            self.open_button.configure(state='normal')
        else:
            self.selected.configure(text='按截止时间升序排列；过期未交作业在最前，未知时间在末尾。')
            self.set_content(None, '选中一项作业，查看所属课程、主要内容和附件名称。')
            self.delete_button.configure(state='disabled')
            self.open_button.configure(state='disabled')

    def set_content(self, signature, text):
        if self.detail_signature == signature:
            return
        self.detail_signature = signature
        self.content.configure(state='normal')
        self.content.delete('1.0', 'end')
        self.content.insert('1.0', text)
        self.content.configure(state='disabled')

    def save_hidden(self, updated):
        try:
            atomic_json(self.hidden_path, updated)
        except OSError:
            messagebox.showerror('保存失败', '无法保存本地删除记录，本次操作没有生效。', parent=self.window)
            return False
        self.hidden = updated
        self.render()
        self.write_health()
        return True

    def hide_selected(self):
        selection = self.table.selection()
        if not selection or selection[0] not in self.rows:
            return
        key = selection[0]
        h = self.rows[key]
        record = dict(h, hiddenAt=datetime.now(timezone.utc).isoformat())
        if self.save_hidden(dict(self.hidden, **{key: record})):
            self.action_note.configure(text=f"已从本地列表删除：{h.get('courseName', '')} · {h['title']}。可从“已删除”恢复。")
            self.populate_hidden()

    def restore_hidden(self, keys):
        keys = set(keys)
        updated = {key: h for key, h in self.hidden.items() if key not in keys}
        count = len(self.hidden) - len(updated)
        if count and self.save_hidden(updated):
            self.action_note.configure(text=f'已恢复 {count} 项。本学期仍未提交的作业会重新显示；正文缺失时可点击“立即刷新”。')
            self.populate_hidden()

    def show_hidden(self):
        if self.hidden_window and self.hidden_window.winfo_exists():
            self.hidden_window.lift()
            return
        dialog = tk.Toplevel(self.window)
        self.hidden_window = dialog
        dialog.title('已删除的作业 · 本地隐藏')
        dialog.geometry('900x440')
        dialog.configure(bg=BG)
        dialog.transient(self.window)
        dialog.columnconfigure(0, weight=1)
        dialog.rowconfigure(1, weight=1)
        tk.Label(dialog, text='已删除的作业不会因刷新或重启重新出现。恢复后，仅本学期仍未提交的作业会显示。',
                 bg=BG, fg=MUTED, anchor='w', padx=18, pady=16, wraplength=840).grid(row=0, column=0, sticky='ew')
        frame = tk.Frame(dialog, bg=BG, padx=18)
        frame.grid(row=1, column=0, sticky='nsew')
        self.hidden_table = ttk.Treeview(frame, columns=('course', 'title', 'time'), show='headings', selectmode='extended', height=4)
        for key, label, width in [('course', '所属课程', 220), ('title', '作业名称', 390), ('time', '删除时间', 180)]:
            self.hidden_table.heading(key, text=label, anchor='w')
            self.hidden_table.column(key, width=width, anchor='w')
        scroll = ttk.Scrollbar(frame, command=self.hidden_table.yview)
        self.hidden_table.configure(yscrollcommand=scroll.set)
        scroll.pack(side='right', fill='y')
        self.hidden_table.pack(fill='both', expand=True)
        controls = tk.Frame(dialog, bg=BG)
        controls.grid(row=2, column=0, sticky='ew')
        self.restore_button = tk.Button(controls, text='恢复选中作业', command=lambda: self.restore_hidden(self.hidden_table.selection()),
                  bg=ACCENT, fg=PAPER, relief='flat', padx=18, pady=8)
        self.restore_button.pack(side='left', padx=18, pady=16)
        tk.Button(controls, text='关闭', command=dialog.destroy, bg=BG, fg=MUTED, relief='flat',
                  padx=18, pady=8).pack(side='right', padx=18, pady=16)
        self.populate_hidden()

    def populate_hidden(self):
        if not self.hidden_window or not self.hidden_window.winfo_exists():
            return
        self.hidden_table.delete(*self.hidden_table.get_children())
        for key, h in sorted(self.hidden.items(), key=lambda entry: entry[1].get('hiddenAt', ''), reverse=True):
            try:
                stamp = datetime.fromisoformat(h['hiddenAt']).astimezone(BEIJING).strftime('%m-%d %H:%M')
            except (KeyError, ValueError):
                stamp = '未知'
            self.hidden_table.insert('', 'end', iid=key, values=(h.get('courseName', ''), h['title'], stamp))

    def refresh(self):
        if self.busy or self.closing or self.login_busy:
            return
        self.busy = True
        self.checking_session = False
        self.session_warning = ''
        self.next_session_check = time.monotonic() + 600
        self.last_error = ''
        self.data_state = 'refreshing'
        self.next_refresh = time.monotonic() + self.interval
        self.refresh_button.configure(state='disabled', text='正在刷新…')
        self.progress.configure(value=0, maximum=1)
        self.status.configure(text='正在获取当前学期课程……', fg=ACCENT)
        self.render()
        self.write_health()
        threading.Thread(target=self.fetch, daemon=True).start()

    def check_session(self):
        if self.busy or self.closing or self.login_busy:
            return
        self.busy = True
        self.checking_session = True
        self.session_refresh_needed = False
        self.session_warning = ''
        self.session_status_before = (self.status.cget('text'), self.status.cget('fg'))
        self.next_session_check = time.monotonic() + 600
        self.refresh_button.configure(state='disabled', text='检查登录…')
        self.status.configure(text='正在检查并维护登录会话，作业列表仍按每小时刷新。', fg=ACCENT)
        threading.Thread(target=self.fetch, args=(True,), daemon=True).start()

    def browser_login(self):
        if self.login_busy:
            return
        if self.busy:
            messagebox.showinfo('正在读取', '请等待本次读取完成后再打开登录窗口。', parent=self.window)
            return
        self.login_busy = True
        self.login_succeeded = False
        self.login_button.configure(state='disabled')
        self.refresh_button.configure(state='disabled')
        self.status.configure(text='正在打开独立浏览器；请在浏览器中手动登录，程序会自动同步 Cookie。', fg=ACCENT)
        threading.Thread(target=self.fetch_login, daemon=True).start()

    def fetch_login(self):
        proc = None
        try:
            proc = subprocess.Popen([self.settings['nodePath'], str(ROOT / 'browser-login.mjs'), str(self.settings_path)],
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                    text=True, encoding='utf-8', creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), cwd=str(ROOT))
            self.login_process = proc
            if self.closing:
                proc.stdin.write('cancel\n')
                proc.stdin.flush()
            final_seen = False
            for line in proc.stdout:
                event = json.loads(line)
                final_seen = final_seen or event.get('event') in ('loginComplete', 'error')
                self.events.put(event)
            proc.wait()
            if not final_seen:
                self.events.put({'event': 'error', 'code': 'PROCESS_ERROR', 'message': '独立登录程序未完成，请重试。'})
        except Exception:
            self.events.put({'event': 'error', 'code': 'PROCESS_ERROR', 'message': '无法打开独立登录程序，请检查浏览器和本地依赖。'})
        finally:
            self.login_process = None
            self.events.put({'event': 'loginFinished'})

    def fetch(self, session_only=False):
        timer = None
        proc = None
        timed_out = threading.Event()
        try:
            command = [self.settings['nodePath'], str(ROOT / 'fetch-homework.mjs'), str(self.settings_path)]
            if session_only:
                command.append('--session-only')
            proc = subprocess.Popen(command,
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding='utf-8',
                                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), cwd=str(ROOT))
            self.process = proc
            if self.closing:
                proc.kill()
                return
            def timeout():
                timed_out.set()
                if proc.poll() is None:
                    proc.kill()
            timer = threading.Timer(300, timeout)
            timer.daemon = True
            timer.start()
            final_seen = False
            for line in proc.stdout:
                event = json.loads(line)
                if event.get('event') in ('result', 'session', 'error'):
                    final_seen = True
                self.events.put(event)
            proc.wait()
            if not final_seen:
                self.events.put({'event': 'error', 'code': 'TIMEOUT' if timed_out.is_set() else 'PROCESS_ERROR',
                                 'message': '刷新超时，将保留上次结果。' if timed_out.is_set() else '读取进程未完成，请检查配置后重试。'})
        except Exception:
            self.events.put({'event': 'error', 'code': 'PROCESS_ERROR', 'message': '无法启动读取程序，请检查 Node.js 和本地配置。'})
        finally:
            if timer:
                timer.cancel()
            if proc and proc.poll() is None:
                proc.kill()
            self.process = None
            self.events.put({'event': 'finished'})

    def poll(self):
        try:
            while True:
                event = self.events.get_nowait()
                kind = event.get('event')
                if kind == 'courses':
                    self.progress.configure(maximum=max(1, event['total']))
                elif kind == 'progress':
                    self.progress.configure(value=event['done'])
                    self.status.configure(text=f"正在核对 {event['done'] + 1}/{event['total']}：{event['course']}")
                elif kind == 'contentProgress':
                    self.progress.configure(maximum=max(1, event['total']), value=event['done'])
                    self.status.configure(text=f"正在读取主要内容 {event['done'] + 1}/{event['total']}：{event['title']}")
                elif kind == 'loginProgress':
                    self.status.configure(text=event['message'], fg=ACCENT)
                elif kind == 'loginComplete':
                    self.login_succeeded = True
                    self.auto_session_enabled = True
                    self.last_error = ''
                    self.next_session_check = time.monotonic() + 600
                    self.status.configure(text='登录成功，Cookie 已自动同步；稍后立即刷新作业。', fg=ACCENT)
                elif kind == 'loginFinished':
                    self.login_busy = False
                    self.login_button.configure(state='normal')
                    self.refresh_button.configure(state='normal', text='立即刷新')
                    if self.login_succeeded and not self.closing:
                        self.window.after(1500, self.refresh)
                elif kind == 'session':
                    self.session_checked_at = event['checkedAt']
                    self.session_refresh_needed = self.last_error in ('AUTH_REQUIRED', 'CSRF_INVALID')
                    if self.session_warning:
                        self.status.configure(text=self.session_warning, fg='#9B5B13')
                    else:
                        self.status.configure(text=self.session_status_before[0], fg=self.session_status_before[1])
                elif kind == 'sessionWarning':
                    self.session_warning = event['message']
                    self.status.configure(text=event['message'], fg='#9B5B13')
                elif kind == 'result':
                    self.data_state = 'partial' if event.get('errors') else 'fresh'
                    self.snapshot = merge_snapshot(self.snapshot, event)
                    self.render()
                    self.progress.configure(maximum=1, value=1)
                    errors = event.get('errors', [])
                    stamp = datetime.fromisoformat(event['fetchedAt'].replace('Z', '+00:00')).astimezone(BEIJING).strftime('%m-%d %H:%M:%S')
                    message = f'最近更新 {stamp}（北京时间）'
                    if errors:
                        self.last_error = 'PARTIAL_FAILURE'
                        message += f"  ·  {len(errors)} 门课程刷新失败，已保留旧数据：" + '、'.join(e['courseName'] for e in errors)
                    elif not self.rows:
                        message += '  ·  当前没有需要显示的作业。'
                    detail_errors = event.get('detailErrors', [])
                    if detail_errors:
                        auth_failed = any(e['code'] in ('AUTH_REQUIRED', 'CSRF_INVALID') for e in detail_errors)
                        self.last_error = 'AUTH_REQUIRED' if auth_failed else self.last_error or 'CONTENT_PARTIAL_FAILURE'
                        message += '  ·  登录已失效，部分正文未更新，请更新 Cookie。' if auth_failed else '  ·  部分作业正文读取失败，请查看缓存或原网页。'
                    if self.session_warning:
                        message += '  ·  ' + self.session_warning
                    self.status.configure(text=message, fg='#9B5B13' if errors or detail_errors or self.session_warning else ACCENT)
                    try:
                        atomic_json(self.cache_path, self.snapshot)
                    except OSError:
                        self.status.configure(text=message + '  ·  缓存保存失败。', fg='#9B5B13')
                elif kind == 'error':
                    self.last_error = event['code']
                    self.data_state = 'failed'
                    self.status.configure(text=f"【{event['code']}】{event['message']} 上次结果保留；下次仍会自动重试。", fg='#B24736')
                    if self.snapshot:
                        self.render()
                    else:
                        self.coverage.configure(text='尚无可用结果，不能判断是否有未交作业。')
                elif kind == 'finished':
                    self.checking_session = False
                    self.busy = False
                    self.refresh_button.configure(state='normal', text='立即刷新')
                    self.write_health()
                    if self.session_refresh_needed and not self.closing:
                        self.session_refresh_needed = False
                        self.window.after(1500, self.refresh)
        except queue.Empty:
            pass
        if not self.closing:
            self.window.after(100, self.poll)

    def tick(self):
        now = time.monotonic()
        remaining = max(0, math.ceil(self.next_refresh - now))
        self.countdown.configure(text='等待浏览器登录' if self.login_busy else '正在检查登录' if self.checking_session
                                 else '正在同步未交作业' if self.busy else f'下次刷新  {remaining // 60:02d}:{remaining % 60:02d}')
        if remaining == 0 and not self.busy:
            self.refresh()
        if self.auto_session_enabled and now >= self.next_session_check and not self.busy and not self.login_busy:
            self.check_session()
        # Local countdown updates never make network requests.
        wall = time.time()
        for key, h in self.rows.items():
            self.table.set(key, 'remaining', remaining_text(h, wall))
        if now - self.last_health >= 30:
            self.render()
            self.write_health()
        if not self.closing:
            self.window.after(1000, self.tick)

    def write_health(self):
        self.last_health = time.monotonic()
        try:
            atomic_json(self.data_dir / 'status.json', {
                'pid': os.getpid(), 'running': not self.closing, 'windowTitle': '作业列表',
                'windowState': self.window.state(), 'refreshSeconds': self.interval, 'refreshing': self.busy,
                'nextRefreshInSeconds': max(0, math.ceil(self.next_refresh - time.monotonic())),
                'updatedAt': datetime.now(timezone.utc).isoformat(),
                'fetchedAt': self.snapshot.get('fetchedAt'), 'courseCount': len(self.snapshot.get('courses', [])),
                'pendingCount': len(self.rows), 'lastError': self.last_error,
                'dataState': self.data_state,
                'autoSessionEnabled': self.auto_session_enabled, 'sessionCheckedAt': self.session_checked_at,
                'sessionIntervalSeconds': 600,
                'nextSessionCheckInSeconds': max(0, math.ceil(self.next_session_check - time.monotonic())) if self.auto_session_enabled else None,
                'sessionPersistenceWarning': bool(self.session_warning),
                'loginInProgress': self.login_busy,
                'hiddenCount': len(self.hidden),
                'layoutVersion': 2,
                'deleteButtonBounds': self.widget_bounds(self.delete_button),
                'loginButtonBounds': self.widget_bounds(self.login_button),
                'contentBounds': self.widget_bounds(self.content),
                'contentLoadedCount': sum(bool(h.get('contentFetchedAt')) for h in self.rows.values()),
                'sortedAscending': all(deadline_seconds(a) <= deadline_seconds(b) for a, b in zip(list(self.rows.values()), list(self.rows.values())[1:])),
            })
        except OSError:
            pass

    def widget_bounds(self, widget):
        x = widget.winfo_rootx() - self.window.winfo_rootx()
        y = widget.winfo_rooty() - self.window.winfo_rooty()
        width, height = widget.winfo_width(), widget.winfo_height()
        return {'x': x, 'y': y, 'width': width, 'height': height,
                'insideWindow': width > 1 and height > 1 and x >= 0 and y >= 0
                and x + width <= self.window.winfo_width() and y + height <= self.window.winfo_height()}

    def open_homework(self):
        selected = self.table.selection()
        if selected:
            url = self.rows[selected[0]].get('url', '')
            if url.startswith('https://learn.tsinghua.edu.cn/'):
                webbrowser.open(url)

    def update_cookie(self):
        if self.busy or self.login_busy:
            messagebox.showinfo('正在刷新', '请等待本次刷新完成后更新 Cookie。', parent=self.window)
            return
        value = simpledialog.askstring('更新 Cookie', '粘贴网络学堂请求头中的 Cookie 值（仅保存在原本地配置文件）：',
                                       show='●', parent=self.window)
        if value is None:
            return
        value = value.strip()
        if not value or '\r' in value or '\n' in value or any(not re.fullmatch(r'[^=;:\s]+=[^;\r\n]*', part.strip()) for part in value.split(';') if part.strip()):
            messagebox.showerror('格式错误', '请只粘贴 Cookie 请求头的值，不含“Cookie：”前缀或换行。', parent=self.window)
            return
        try:
            path = Path(self.settings['configPath'])
            config = json.loads(path.read_text(encoding='utf-8-sig'))
            config.update(cookie=value, csrfToken=None)
            atomic_json(path, config)
            atomic_json(self.data_dir / 'browser-session.json', {'enabled': False})
            self.auto_session_enabled = False
        except (OSError, ValueError):
            messagebox.showerror('保存失败', '无法更新原本地配置文件，请检查路径和写入权限。', parent=self.window)
            return
        self.refresh()

    def minimize(self):
        self.window.iconify()
        self.write_health()

    def exit(self):
        self.closing = True
        if self.process and self.process.poll() is None:
            self.process.kill()
        if self.login_process and self.login_process.poll() is None:
            try:
                self.login_process.stdin.write('cancel\n')
                self.login_process.stdin.flush()
            except (OSError, ValueError):
                pass
        self.write_health()
        self.window.destroy()


def main():
    import msvcrt
    (ROOT / 'data').mkdir(exist_ok=True)
    lock = (ROOT / 'data' / 'instance.lock').open('a+b')
    if lock.tell() == 0:
        lock.write(b'0')
        lock.flush()
    lock.seek(0)
    window = tk.Tk()
    window.withdraw()
    try:
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError:
        messagebox.showinfo('作业列表', '程序已在运行，请从任务栏恢复“作业列表”窗口。', parent=window)
        window.destroy()
        lock.close()
        return
    try:
        try:
            previous_state = json.loads((ROOT / 'data' / 'status.json').read_text(encoding='utf-8')).get('windowState')
        except (OSError, ValueError):
            previous_state = None
        app = HomeworkApp(window)
        window.deiconify()
        if previous_state == 'zoomed':
            window.state('zoomed')
        window.mainloop()
    except Exception:
        messagebox.showerror('作业列表', '程序无法启动，请检查 app-settings.json 及 Python、Node.js 环境。', parent=window)
    finally:
        lock.close()


if __name__ == '__main__':
    main()
