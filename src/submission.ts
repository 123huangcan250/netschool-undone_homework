import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { LearnService } from './learn.js';
import { AppError } from './errors.js';
import { checkFormat, fingerprint, prepareUpload, type Upload } from './files.js';
import { SubmissionSchema, type HomeworkDetail, type Submission } from './models.js';
import { htmlText } from './parsers.js';

const ReceiptSchema = z.object({
  fingerprint: z.string(), homeworkKey: z.string(), state: z.enum(['pending', 'uncertain', 'verified', 'rejected']),
  startedAt: z.string(), result: SubmissionSchema.optional(),
  baseline: z.string(),
});
type Receipt = z.infer<typeof ReceiptSchema>;

export class SubmissionService {
  private busy = false;
  constructor(readonly learn: LearnService) {}

  private checkDeadline(detail: HomeworkDetail): void {
    const config = this.learn.config.submission;
    const now = this.learn.http.runtime.now();
    if (detail.submissionType !== null && detail.submissionType !== 2) throw new AppError('SUBMISSION_REJECTED', '此作业要求线下或其他方式提交。', false, '按课程说明提交。');
    if (detail.startAt && now < Date.parse(detail.startAt)) throw new AppError('SUBMISSION_REJECTED', '此作业尚未开始接收提交。');
    if (!detail.deadline && !config.allowUnknownDeadline) throw new AppError('DEADLINE_UNKNOWN', '无法确认截止时间，未提交。', false, '在浏览器核对截止时间；必要时修正接口解析配置。');
    if (detail.deadline && now >= Date.parse(detail.deadline)) {
      if (!(config.allowLateSubmission && detail.lateDeadline && now < Date.parse(detail.lateDeadline))) {
        throw new AppError('DEADLINE_PASSED', '作业已过截止时间，未提交。', false, '核对课程补交政策；允许补交时可在本地配置启用 allowLateSubmission。');
      }
    }
  }

  private async loadReceipts(): Promise<Receipt[]> {
    try { return z.array(ReceiptSchema).parse(JSON.parse(await readFile(this.learn.config.submission.receiptFile, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new AppError('STATE_ERROR', '提交回执文件不可读取或已损坏。', false, '核对本地回执文件与浏览器提交记录后修复文件。');
    }
  }
  private async saveReceipts(receipts: Receipt[]): Promise<void> {
    const target = this.learn.config.submission.receiptFile;
    const tmp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(receipts, null, 2), { mode: 0o600 });
      await rename(tmp, target);
    } catch { throw new AppError('STATE_ERROR', '无法保存提交回执。', false, '检查回执目录权限；先核对浏览器记录再调用提交。'); }
    finally { await unlink(tmp).catch(() => {}); }
  }

  private matches(detail: HomeworkDetail, upload: Upload, content: string): boolean {
    return detail.status !== 'unsubmitted' && detail.submission.attachments.some(a => a.name === upload.filename) &&
      detail.submission.contentText.replace(/\s+/g, ' ').trim() === htmlText(content).replace(/\s+/g, ' ').trim();
  }

  private marker(detail: HomeworkDetail): string {
    return JSON.stringify([detail.status, detail.submittedAt, detail.submission.attachments.map(a => a.id ?? a.url)]);
  }

  private async verify(homeworkId: string, upload: Upload, content: string, baseline?: string): Promise<boolean> {
    for (let attempt = 0; attempt < this.learn.config.submission.verificationAttempts; attempt++) {
      try {
        const detail = await this.learn.getHomeworkDetail(homeworkId);
        if (this.matches(detail, upload, content) && (baseline === undefined || this.marker(detail) !== baseline)) return true;
      } catch (error) {
        if (!(error instanceof AppError) || !error.retryable) break;
      }
    }
    return false;
  }

  async submit(homeworkId: string, paths: string[], remarks = ''): Promise<Submission> {
    if (this.busy) throw new AppError('SUBMISSION_BUSY', '已有提交正在处理。', true, '等待前一次操作完成。');
    this.busy = true;
    const config = this.learn.config;
    const lockPath = `${config.submission.receiptFile}.lock`;
    let locked = false;
    try {
      await mkdir(dirname(config.submission.receiptFile), { recursive: true, mode: 0o700 });
      try {
        const lock = await open(lockPath, 'wx', 0o600);
        locked = true;
        await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
        await lock.close();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AppError('SUBMISSION_BUSY', '其他进程正在提交，或上次进程未正常退出。', false, '等待其他进程结束；若为残留锁，先核对浏览器记录，再删除本地回执旁的 .lock 文件。');
        throw new AppError('STATE_ERROR', '无法创建提交锁。', false, '检查回执目录权限。');
      }
      const detail = await this.learn.getHomeworkDetail(homeworkId);
      const upload = await prepareUpload(paths, detail.requirements, config);
      // Remarks are plain text; escape to prevent accidentally creating HTML markup.
      const content = remarks.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
      const fp = fingerprint(homeworkId, upload, content, config);
      const homeworkKey = createHash('sha256').update(JSON.stringify([config.baseUrl, config.cookie, homeworkId])).digest('hex');
      const receipts = await this.loadReceipts();
      const previous = receipts.find(r => r.fingerprint === fp && r.state !== 'rejected');
      const result = (alreadySubmitted: boolean): Submission => ({
        homeworkId, status: 'verified', verifiedAt: new Date(this.learn.http.runtime.now()).toISOString(),
        uploadedFilename: upload.filename, sourceFiles: upload.sourceFiles, sha256: upload.sha256,
        packagedAsZip: upload.packagedAsZip, alreadySubmitted, verification: 'status_filename_content',
      });
      if (previous) {
        const currentMatches = this.matches(detail, upload, content) && (previous.state === 'verified' || this.marker(detail) !== previous.baseline);
        if (!currentMatches && !await this.verify(homeworkId, upload, content, previous.state === 'verified' ? undefined : previous.baseline)) {
          throw new AppError('SUBMISSION_UNCERTAIN', '相同文件与备注已有提交回执，但当前记录无法核验，未重发。', false, '在浏览器核对附件内容和正文；回执仅可在人工核对后清理。');
        }
        previous.state = 'verified'; previous.result = result(true);
        await this.saveReceipts(receipts);
        return previous.result;
      }
      if (receipts.some(r => r.homeworkKey === homeworkKey && ['pending', 'uncertain'].includes(r.state))) throw new AppError('SUBMISSION_UNCERTAIN', '此作业仍有结果未确认的提交，未覆盖提交。', false, '先在浏览器确认上次结果，再处理本地回执。');
      this.checkDeadline(detail);
      // Fetch fresh hidden fields only for a new submission with an open window.
      // Existing receipts can still be verified after the submission page closes.
      const form = await this.learn.getSubmitForm(detail);
      if (form.disabled) throw new AppError('SUBMISSION_REJECTED', '提交表单当前不可用。');
      if (form.requirements.maxRemarksLength !== null && remarks.length > form.requirements.maxRemarksLength) {
        throw new AppError('INVALID_INPUT', `备注超过提交页面允许的 ${form.requirements.maxRemarksLength} 字符。`, false, '缩短 remarks 后再提交。');
      }
      checkFormat(upload.filename, form.requirements, config);
      if (form.requirements.maxFileBytes !== null && upload.bytes.length > form.requirements.maxFileBytes) {
        throw new AppError('FILE_NOT_ALLOWED', '最终附件超过最新提交表单的大小限制。', false, '缩小附件后重试。');
      }
      const receipt: Receipt = { fingerprint: fp, homeworkKey, state: 'pending', startedAt: new Date(this.learn.http.runtime.now()).toISOString(), baseline: this.marker(detail) };
      receipts.push(receipt);
      await this.saveReceipts(receipts);
      let sentError: unknown;
      try { await this.learn.postSubmission(detail, form, upload.filename, upload.bytes, content, () => this.checkDeadline(detail)); }
      catch (error) {
        sentError = error;
        if (error instanceof AppError && ['AUTH_REQUIRED', 'CSRF_INVALID', 'SUBMISSION_REJECTED', 'DEADLINE_PASSED', 'DEADLINE_UNKNOWN'].includes(error.code)) {
          receipt.state = 'rejected'; await this.saveReceipts(receipts); throw error;
        }
      }
      if (await this.verify(homeworkId, upload, content, receipt.baseline)) {
        receipt.state = 'verified'; receipt.result = result(false);
        await this.saveReceipts(receipts);
        return receipt.result;
      }
      receipt.state = 'uncertain';
      await this.saveReceipts(receipts);
      throw new AppError('SUBMISSION_UNCERTAIN', sentError ? '提交请求异常，且查询未能确认附件与正文，未自动重发。' : '服务器响应成功，但未能核验提交状态、附件名与正文。', false, '在浏览器核对最新提交；不要盲目重复提交。');
    } finally {
      if (locked) await unlink(lockPath).catch(() => {});
      this.busy = false;
    }
  }
}
