#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { asAppError } from './errors.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--config')) throw new Error('Usage: node dist/index.js [--config /absolute/path/local.json]');
  const config = await loadConfig(args[1]);
  const server = createServer(config);
  await server.connect(new StdioServerTransport());
  const close = () => { void server.close().finally(() => { process.exitCode = 0; }); };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
main().catch(error => {
  const e = asAppError(error);
  process.stderr.write(JSON.stringify({ code: e.code, message: e.message, remediation: e.remediation }) + '\n');
  process.exitCode = 1;
});
