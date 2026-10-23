import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../src/config.js';
import { createServer } from '../src/server.js';

const config = await loadConfig(fileURLToPath(new URL('../config/example.json', import.meta.url)));
const server = createServer(config);
const client = new Client({ name: 'schema-export', version: '1' });
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
try {
  await client.connect(b);
  const tools = await client.listTools();
  const target = fileURLToPath(new URL('../docs/tools.json', import.meta.url));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(tools, null, 2) + '\n');
  process.stdout.write(`Exported ${tools.tools.length} tool definitions.\n`);
} finally { await client.close(); await server.close(); }
