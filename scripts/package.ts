import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { zipSync, unzipSync } from 'fflate';

const root = fileURLToPath(new URL('../', import.meta.url));
const entries: Record<string, Uint8Array> = {};
const directories = ['src', 'dist', 'test', 'scripts', 'docs', 'evaluations', 'desktop-app'];
async function add(path: string): Promise<void> {
  const bytes = await readFile(join(root, path));
  entries[`thu-learn-mcp-server/${path.replaceAll('\\', '/')}`] = bytes;
}
async function walk(dir: string): Promise<void> {
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    if (['__pycache__', 'data', 'app-settings.json'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile()) await add(path);
  }
}
for (const dir of directories) await walk(dir);
for (const path of ['package.json', 'package-lock.json', 'tsconfig.json', '.gitignore', '.gitattributes', 'README.md', 'DEPENDENCIES.md', 'THIRD_PARTY_NOTICES.md', 'config/example.json', 'config/protocol.json', 'submissions/.gitkeep']) await add(path);
const zip = zipSync(entries, { level: 6 });
const verified = unzipSync(zip);
for (const [name, bytes] of Object.entries(verified)) {
  if (/node_modules|\.research|config\/local\.json|\.state\/|\.har$/i.test(name)) throw new Error('Private/unnecessary file in archive');
  if (!Buffer.from(bytes).equals(Buffer.from(entries[name]!))) throw new Error('Archive verification failed');
}
const target = fileURLToPath(new URL('../../thu-learn-mcp-server.zip', import.meta.url));
await writeFile(target, zip);
process.stdout.write(JSON.stringify({ archive: target, files: Object.keys(entries).length, bytes: zip.length, sha256: createHash('sha256').update(zip).digest('hex') }) + '\n');
