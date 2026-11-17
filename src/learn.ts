import { interpolate, type LoadedConfig } from './config.js';
import { writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { AppError, protocolError } from './errors.js';
import { LearnHttpClient, type Runtime } from './http.js';
import type { Course, Homework, HomeworkDetail, Status } from './models.js';
import { decode, deduplicate, normalizeHomework, parseDetail, parseSubmitForm, record, type Row, type SubmitForm } from './parsers.js';

export class LearnService {
  readonly http: LearnHttpClient;
  private index = new Map<string, Homework>();
  constructor(readonly config: LoadedConfig, runtime?: Runtime) { this.http = new LearnHttpClient(config, runtime); }

  async getCourseList(): Promise<{ semesterId: string; courses: Course[] }> {
    let semesterId = this.config.semesterId;
    if (!semesterId) {
      const value = record(await this.http.json(this.config.protocol.currentSemester));
      const result = record(value.result);
      if (value.message !== 'success' || typeof result.id !== 'string' || !result.id) throw protocolError('当前学期响应缺少 result.id。');
      semesterId = result.id;
    }
    const value = record(await this.http.json(interpolate(this.config.protocol.courseList, { semesterId, language: this.config.language })));
    if (value.message !== 'success' || !Array.isArray(value.resultList)) throw protocolError('课程列表响应缺少 resultList。');
    const courses = value.resultList.map(item => {
      const row = record(item);
      if (!row.wlkcid || !(row.zywkcm || row.kcm || row.ywkcm)) throw protocolError('课程记录缺少课程 ID 或名称。');
      const courseId = String(row.wlkcid);
      return {
        courseId, name: decode(row.zywkcm || row.kcm || row.ywkcm), teacher: row.jsm ? decode(row.jsm) : null, semesterId,
        url: new URL(`/f/wlxt/index/course/student/course?wlkcid=${encodeURIComponent(courseId)}`, this.config.baseUrl).href,
      };
    });
    return { semesterId, courses: courses.filter((c, i) => courses.findIndex(x => x.courseId === c.courseId) === i) };
  }

  private async listCategory(courseId: string, status: Status): Promise<Homework[]> {
    const items: Homework[] = [];
    let previousSignature = '';
    let offset = 0;
    for (let page = 0; page < this.config.maxPages; page++) {
      const value = record(await this.http.json(this.config.protocol.homeworkLists[status], {
        method: 'POST', replaySafe: true,
        body: () => {
          const form = new FormData();
          const filters: { name: string; value: string | number }[] = [{ name: 'wlkcid', value: courseId }];
          if (offset > 0) filters.push({ name: 'iDisplayStart', value: offset }, { name: 'iDisplayLength', value: this.config.pageSize });
          form.append('aoData', JSON.stringify(filters));
          return form;
        },
      }));
      if (value.result !== 'success') throw protocolError('作业列表 result 不是 success。');
      const object = record(value.object);
      if (!Array.isArray(object.aaData)) throw protocolError('作业列表缺少 object.aaData。');
      const rows = object.aaData.map(item => record(item));
      if (rows.some(row => row.wlkcid && String(row.wlkcid) !== courseId)) throw protocolError('作业列表包含其他课程的记录。');
      const signature = JSON.stringify(rows.map(r => r.xszyid));
      if (offset && previousSignature === signature) throw protocolError('服务端未响应分页参数，无法保证作业列表完整。');
      previousSignature = signature;
      items.push(...rows.map(row => normalizeHomework(row, courseId, status, this.config, this.http.runtime.now())));
      offset += rows.length;
      const totalRaw = object.iTotalDisplayRecords ?? object.iTotalRecords;
      if (totalRaw === undefined || totalRaw === null) return items;
      const total = Number(totalRaw);
      if (!Number.isInteger(total) || total < 0) throw protocolError('作业分页总数无效。');
      if (offset >= total) return items;
      if (!rows.length) throw protocolError('作业列表提前结束，返回数量小于总数。');
    }
    throw protocolError('作业分页达到配置上限，未返回不完整列表。');
  }

  async getHomeworkList(courseId: string): Promise<{ courseId: string; fetchedAt: string; homeworks: Homework[] }> {
    const items: Homework[] = [];
    for (const status of ['unsubmitted', 'submitted', 'graded'] as const) items.push(...await this.listCategory(courseId, status));
    const homeworks = deduplicate(items);
    for (const homework of homeworks) this.index.set(homework.homeworkId, homework);
    return { courseId, fetchedAt: new Date(this.http.runtime.now()).toISOString(), homeworks };
  }

  /** Read-only dashboard path: avoid requesting submitted and graded categories. */
  async getUnsubmittedHomeworkList(courseId: string): Promise<{ courseId: string; fetchedAt: string; homeworks: Homework[] }> {
    const homeworks = deduplicate(await this.listCategory(courseId, 'unsubmitted'));
    for (const homework of homeworks) this.index.set(homework.homeworkId, homework);
    return { courseId, fetchedAt: new Date(this.http.runtime.now()).toISOString(), homeworks };
  }

  private async resolveHomework(homeworkId: string): Promise<Homework> {
    const known = this.index.get(homeworkId);
    if (known) {
      const refreshed = (await this.getHomeworkList(known.courseId)).homeworks.find(h => h.homeworkId === homeworkId);
      if (refreshed) return refreshed;
      this.index.delete(homeworkId);
      throw new AppError('NOT_FOUND', '当前课程中已找不到该作业。', false, '重新拉取课程与作业列表。');
    }
    const { courses } = await this.getCourseList();
    for (const course of courses) {
      const found = (await this.getHomeworkList(course.courseId)).homeworks.find(h => h.homeworkId === homeworkId);
      if (found) return found;
    }
    throw new AppError('NOT_FOUND', '当前账号、当前学期未找到该 homeworkId。', false, 'homeworkId 应使用列表返回的 xszyid；检查 semesterId 配置。');
  }

  private async readHomeworkContent(homework: Homework): Promise<HomeworkDetail> {
    const html = await this.http.text(homework.url);
    const json = await this.http.json(this.config.protocol.homeworkDetail, {
      method: 'POST', replaySafe: true,
      body: () => { const form = new FormData(); form.append('id', homework.assignmentId); return form; },
    });
    return parseDetail(homework, html, json, this.config);
  }

  /** Read description/attachment names for a freshly listed homework, without submission forms. */
  async getHomeworkContent(homeworkId: string): Promise<HomeworkDetail> {
    const homework = this.index.get(homeworkId);
    if (!homework) throw new AppError('NOT_FOUND', '请先读取该课程的作业列表。');
    return this.readHomeworkContent(homework);
  }

  async getHomeworkDetail(homeworkId: string): Promise<HomeworkDetail> {
    const homework = await this.resolveHomework(homeworkId);
    const detail = await this.readHomeworkContent(homework);
    const now = this.http.runtime.now();
    const normalWindowOpen = detail.deadline === null || now < Date.parse(detail.deadline);
    const lateWindowOpen = detail.lateDeadline !== null && now < Date.parse(detail.lateDeadline);
    if (detail.submissionType === 2 && detail.status !== 'graded' && (normalWindowOpen || lateWindowOpen)) {
      try {
        const form = await this.getSubmitForm(detail);
        detail.requirements = { ...form.requirements, instructions: [detail.descriptionText, form.requirements.instructions].filter(Boolean).join('\n') };
      } catch (error) {
        if (!(error instanceof AppError) || !['PROTOCOL_CHANGED', 'UPSTREAM_ERROR'].includes(error.code)) throw error;
        detail.warnings.push('提交表单读取失败，已返回作业正文和附件，提交限制暂时未知。');
      }
    } else if (detail.submissionType === 2 && detail.status !== 'graded') {
      detail.warnings.push('正常提交及补交窗口已关闭，未请求提交表单；已有内容仍可读取。');
    }
    return detail;
  }

  async downloadHomeworkAttachment(homeworkId: string, attachmentIndex: number, destinationPath: string) {
    if (!isAbsolute(destinationPath)) throw new AppError('INVALID_INPUT', '保存路径必须是绝对路径。');
    const homework = await this.resolveHomework(homeworkId);
    const detail = await this.readHomeworkContent(homework);
    const attachment = detail.attachments[attachmentIndex];
    if (!attachment) throw new AppError('NOT_FOUND', '附件序号不存在。', false, '先读取作业详情，使用 attachments 数组中的零起始序号。');
    const bytes = await this.http.download(attachment.url);
    try {
      await writeFile(destinationPath, bytes, { flag: 'wx' });
    } catch {
      throw new AppError('FILE_NOT_ALLOWED', '无法保存附件，目标文件可能已存在或目录不可写。', false, '指定不存在的绝对文件路径，并确认父目录已存在。');
    }
    return { homeworkId, attachmentIndex, name: attachment.name, role: attachment.role, path: destinationPath,
      bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }

  async getSubmitForm(homework: Homework): Promise<SubmitForm> {
    const html = await this.http.text(interpolate(this.config.protocol.submitPage, { courseId: homework.courseId, homeworkId: homework.homeworkId }));
    return parseSubmitForm(html, this.config);
  }

  async postSubmission(homework: Homework, form: SubmitForm, filename: string, bytes: Uint8Array, content: string, beforeSend?: () => void): Promise<void> {
    let value: Row;
    try {
      value = record(await this.http.json(this.config.protocol.submit, {
        method: 'POST', replaySafe: false,
        beforeSend,
        referer: interpolate(this.config.protocol.submitPage, { courseId: homework.courseId, homeworkId: homework.homeworkId }),
        body: () => {
          const body = new FormData();
          for (const [key, val] of Object.entries(form.hidden)) body.set(key, val);
          const fields = this.config.protocol.fields;
          body.set(fields.homeworkId, homework.homeworkId);
          body.set(fields.content, content);
          body.set(fields.deleted, '0');
          body.set(fields.file, new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }), filename);
          return body;
        },
      }));
    } catch (error) {
      if (error instanceof AppError && error.code === 'PROTOCOL_CHANGED') throw new AppError('SUBMISSION_UNCERTAIN', '提交响应无法解析，未重发。', false, '核对最新提交记录。');
      throw error;
    }
    if (value.result === undefined) throw new AppError('SUBMISSION_UNCERTAIN', '提交响应缺少 result，未自动重发。', false, '核对最新提交记录及接口响应结构。');
    if (value.result !== 'success') throw new AppError('SUBMISSION_REJECTED', '服务器未确认提交成功。', false, '在浏览器核对作业提交要求、截止时间与权限；错误原文未回传，以免泄露会话信息。');
  }
}
