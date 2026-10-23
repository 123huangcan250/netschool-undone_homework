import { loadConfig } from '../src/config.js';
import { LearnService } from '../src/learn.js';
import { asAppError } from '../src/errors.js';

// Read-only live check. Prints counts and IDs only; never posts coursework.
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const i = args.indexOf('--config');
  const j = args.indexOf('--course');
  const config = await loadConfig(i >= 0 ? args[i + 1] : undefined);
  const learn = new LearnService(config);
  const courses = await learn.getCourseList();
  process.stdout.write(JSON.stringify({ ok: true, stage: 'courses', semesterId: courses.semesterId, count: courses.courses.length }) + '\n');
  const courseId = j >= 0 ? args[j + 1] : undefined;
  if (courseId) {
    if (!courses.courses.some(c => c.courseId === courseId)) throw new Error('Course outside configured semester');
    const list = await learn.getHomeworkList(courseId);
    process.stdout.write(JSON.stringify({ ok: true, stage: 'homeworks', courseId, count: list.homeworks.length, missingDeadlines: list.homeworks.filter(h => !h.deadline).length }) + '\n');
    if (list.homeworks[0]) {
      const detail = await learn.getHomeworkDetail(list.homeworks[0].homeworkId);
      process.stdout.write(JSON.stringify({ ok: true, stage: 'detail', descriptionPresent: Boolean(detail.descriptionText), attachmentCount: detail.attachments.length, status: detail.status }) + '\n');
    }
  }
}
main().catch(error => {
  const e = asAppError(error);
  process.stdout.write(JSON.stringify({ ok: false, error: { code: e.code, message: e.message, remediation: e.remediation } }) + '\n');
  process.exitCode = 1;
});
