import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import type { LoadedConfig } from './config.js';
import type { Requirements } from './models.js';
import { AppError } from './errors.js';

export interface Upload {
  filename: string;
  bytes: Uint8Array;
  sourceFiles: string[];
  sha256: string;
  packagedAsZip: boolean;
}
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const fail = (message: string): never => { throw new AppError('FILE_NOT_ALLOWED', message, false, '核对文件路径、课程格式要求及 submission 配置。'); };
const MIME: Record<string, string> = {
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.txt': 'text/plain',
  '.md': 'text/markdown', '.csv': 'text/csv', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
export function checkFormat(filename: string, requirements: Requirements, config: LoadedConfig): void {
  const ext = extname(filename).toLowerCase();
  if (config.submission.allowedExtensions.length && !config.submission.allowedExtensions.map(v => v.toLowerCase()).includes(ext)) fail(`文件 ${filename} 不在本地允许格式中。`);
  if (!requirements.acceptedExtensions.length) return;
  const mime = MIME[ext];
  const accepted = requirements.acceptedExtensions.some(rule => rule === '*/*' || rule === ext ||
    (mime && (rule === mime || (rule.endsWith('/*') && mime.startsWith(rule.slice(0, -1))))));
  if (!accepted) fail(`课程提交表单不接受 ${ext || '无扩展名文件'} 格式。`);
}

export async function prepareUpload(paths: string[], requirements: Requirements, config: LoadedConfig): Promise<Upload> {
  if (!paths.length || paths.length > config.submission.maxFiles) fail('附件数量超出配置范围。');
  if (paths.length > 1 && config.submission.multiFileMode === 'reject') fail('当前配置未启用多文件 ZIP 打包。');
  const roots: string[] = [];
  for (const root of config.submission.allowedRoots) {
    try { roots.push(await realpath(root)); } catch { /* missing roots never grant access */ }
  }
  const files: { name: string; bytes: Uint8Array }[] = [];
  const seenPaths = new Set<string>();
  const names = new Set<string>();
  let total = 0;
  for (const path of paths) {
    if (!isAbsolute(path)) fail('附件路径必须为绝对路径。');
    const actual = await realpath(path).catch(() => fail('附件不存在或不可读取。'));
    if (!roots.some(root => { const rel = relative(root, actual); return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); })) fail('附件不在 allowedRoots 内，或符号链接指向目录外。');
    if (seenPaths.has(actual)) continue;
    seenPaths.add(actual);
    const name = basename(actual);
    if (/[\r\n\0]/.test(name)) fail('附件名称包含无效字符。');
    if (names.has(name.toLowerCase())) fail('多文件包含同名文件，请先重命名。');
    names.add(name.toLowerCase());
    let info;
    try { info = await stat(actual); } catch { fail('无法读取附件属性。'); }
    if (!info!.isFile()) fail('附件路径必须为普通文件。');
    if (info!.size > config.submission.maxFileBytes) fail('单文件大小超过配置限制。');
    if (info!.size === 0) fail('附件为空文件。');
    total += info!.size;
    if (total > config.submission.maxTotalBytes) fail('附件总大小超过配置限制。');
    let bytes: Buffer;
    try { bytes = await readFile(actual); } catch { fail('无法读取附件内容。'); }
    if (bytes!.length !== info!.size) fail('附件在读取过程中发生变化，请重试。');
    if (config.submission.allowedExtensions.length) {
      const ext = extname(name).toLowerCase();
      if (!config.submission.allowedExtensions.map(v => v.toLowerCase()).includes(ext)) fail(`源文件 ${name} 不在本地允许格式中。`);
    }
    files.push({ name, bytes: bytes! });
  }
  const packagedAsZip = files.length > 1;
  const filename = packagedAsZip ? config.submission.archiveName : files[0]!.name;
  checkFormat(filename, requirements, config);
  const bytes = packagedAsZip ? zipSync(Object.fromEntries(files.map(file => [file.name, [file.bytes, { mtime: new Date('1980-01-01T00:00:00Z') }]])), { level: 6 }) : files[0]!.bytes;
  const limit = Math.min(config.submission.maxFileBytes, requirements.maxFileBytes ?? Infinity);
  if (bytes.length > limit || bytes.length > config.submission.maxTotalBytes) fail('最终上传附件超过大小限制。');
  return { filename, bytes, sourceFiles: files.map(f => f.name), sha256: hash(bytes), packagedAsZip };
}

export function fingerprint(homeworkId: string, upload: Upload, content: string, config: LoadedConfig): string {
  return hash(JSON.stringify([config.baseUrl, hash(config.cookie), homeworkId, upload.filename, upload.sha256, content]));
}
