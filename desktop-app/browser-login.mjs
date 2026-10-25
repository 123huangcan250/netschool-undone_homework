import { syncBrowserSession } from './browser-session.mjs';
import { refreshErrorEvent } from './refresh-errors.mjs';
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const cancellation = new AbortController();
process.stdin.on('data', () => cancellation.abort());
try { emit(await syncBrowserSession(process.argv[2], { interactive: true, emit, signal: cancellation.signal })); }
catch (error) { emit(refreshErrorEvent(error)); process.exitCode = 1; }
finally { process.stdin.destroy(); }
