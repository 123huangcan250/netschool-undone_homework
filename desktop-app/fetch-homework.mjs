// One read-only refresh. stdout is a JSON-lines protocol consumed by the desktop UI.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const optionalJson = async path => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return {}; } };
try {
  const settings = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const hidden = await optionalJson(resolve(dirname(process.argv[2]), 'data', 'hidden.json'));
  const moduleUrl = name => pathToFileURL(resolve(settings.projectDir, 'dist', name)).href;
  const [{ loadConfig }, { LearnService }, { asAppError }] = await Promise.all([
    import(moduleUrl('config.js')), import(moduleUrl('learn.js')), import(moduleUrl('errors.js')),
  ]);
  const config = await loadConfig(settings.configPath);
  // The dashboard always follows the server's current semester, without editing MCP configuration.
  const service = new LearnService({ ...config, semesterId: null });
  const { semesterId, courses } = await service.getCourseList();
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
  emit({ event: 'result', semesterId, courses, homeworks, completedCourseIds, errors, detailErrors, fetchedAt: new Date().toISOString() });
} catch (error) {
  // Never include raw exceptions, headers, request bodies, or credentials.
  const code = ['AUTH_REQUIRED', 'CSRF_INVALID', 'NETWORK_ERROR', 'CONFIG_ERROR', 'RATE_LIMITED', 'UPSTREAM_ERROR', 'PROTOCOL_CHANGED'].includes(error?.code) ? error.code : 'CONFIG_ERROR';
  const message = code === 'AUTH_REQUIRED' || code === 'CSRF_INVALID'
    ? '登录已失效，请更新 Cookie 后重新刷新。'
    : '刷新失败，请检查登录配置、网络连接及程序依赖。';
  emit({ event: 'error', code, message });
  process.exitCode = 1;
}
