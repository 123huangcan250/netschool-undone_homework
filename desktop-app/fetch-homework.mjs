// One read-only refresh. stdout is a JSON-lines protocol consumed by the desktop UI.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { refreshErrorEvent } from './refresh-errors.mjs';
import { browserSessionEnabled, syncBrowserSession } from './browser-session.mjs';
import { saveCookie } from './session-cookie.mjs';

const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const optionalJson = async path => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return {}; } };
try {
  const settings = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const hidden = await optionalJson(resolve(dirname(process.argv[2]), 'data', 'hidden.json'));
  const moduleUrl = name => pathToFileURL(resolve(settings.projectDir, 'dist', name)).href;
  const [{ loadConfig }, { LearnService }, { asAppError }] = await Promise.all([
    import(moduleUrl('config.js')), import(moduleUrl('learn.js')), import(moduleUrl('errors.js')),
  ]);
  let config = await loadConfig(settings.configPath);
  // The dashboard always follows the server's current semester, without editing MCP configuration.
  let service = new LearnService({ ...config, semesterId: null });
  let inventory;
  try { inventory = await service.getCourseList(); }
  catch (error) {
    if (!['AUTH_REQUIRED', 'CSRF_INVALID'].includes(error?.code) || !await browserSessionEnabled(process.argv[2])) throw error;
    emit({ event: 'loginProgress', message: '当前 Cookie 已失效，正在尝试同步独立浏览器会话。' });
    try { await syncBrowserSession(process.argv[2]); } catch { throw error; }
    await new Promise(resolve => setTimeout(resolve, 1000));
    config = await loadConfig(settings.configPath);
    service = new LearnService({ ...config, semesterId: null });
    inventory = await service.getCourseList();
  }
  const { semesterId, courses } = inventory;
  const persistSession = async () => {
    try { await saveCookie(settings.configPath, await service.http.exportCookieHeader(), config.cookie); }
    catch { emit({ event: 'sessionWarning', message: '本次读取成功，但自动保存轮换后的 Cookie 失败。' }); }
  };
  if (process.argv.includes('--session-only')) {
    await persistSession();
    emit({ event: 'session', valid: true, checkedAt: new Date().toISOString() });
    process.exitCode = 0;
  } else {
  emit({ event: 'courses', total: courses.length, semesterId });
  const homeworks = [], completedCourseIds = [], errors = [];
  for (const [index, course] of courses.entries()) {
    emit({ event: 'progress', done: index, total: courses.length, course: course.name });
    try {
      const result = await service.getUnsubmittedHomeworkList(course.courseId);
      completedCourseIds.push(course.courseId);
      for (const h of result.homeworks) homeworks.push({ ...h, courseName: course.name });
    } catch (error) {
      const safe = asAppError(error);
      errors.push({ courseId: course.courseId, courseName: course.name, code: safe.code, message: safe.message });
      if (safe.code === 'AUTH_REQUIRED' || safe.code === 'CSRF_INVALID') throw safe;
    }
  }
  // Fetch content only after all course inventories are complete. Hidden items remain in
  // the inventory so restoring one works, but don't spend requests on their descriptions.
  const detailErrors = [];
  const visible = homeworks.filter(h => !hidden[`${h.courseId}:${h.homeworkId}`]);
  for (const [index, h] of visible.entries()) {
    emit({ event: 'contentProgress', done: index, total: visible.length, title: h.title });
    try {
      const detail = await service.getHomeworkContent(h.homeworkId);
      Object.assign(h, { descriptionText: detail.descriptionText,
        assignmentAttachments: detail.attachments.filter(a => a.role === 'assignment').map(a => ({ name: a.name })),
        contentFetchedAt: new Date().toISOString(), contentStatus: 'fresh' });
    } catch (error) {
      const safe = asAppError(error);
      h.contentStatus = 'failed';
      detailErrors.push({ courseId: h.courseId, homeworkId: h.homeworkId, code: safe.code });
      // Preserve a completed inventory even if login expires while reading descriptions.
      if (safe.code === 'AUTH_REQUIRED' || safe.code === 'CSRF_INVALID') {
        for (const pending of visible.slice(index)) pending.contentStatus = 'failed';
        break;
      }
    }
  }
  // Don't save an anonymous replacement cookie after an authentication failure.
  if (!detailErrors.some(e => ['AUTH_REQUIRED', 'CSRF_INVALID'].includes(e.code))) await persistSession();
  emit({ event: 'result', semesterId, courses, homeworks, completedCourseIds, errors, detailErrors, fetchedAt: new Date().toISOString() });
  }
} catch (error) {
  emit(refreshErrorEvent(error));
  process.exitCode = 1;
}
