require('dotenv').config();
const cron = require('node-cron');
const { runDailyReport } = require('./report');

// Default: every day at midnight — report covers the previous day's calls
// Override with CRON_SCHEDULE env var if needed (standard cron syntax)
const SCHEDULE = process.env.CRON_SCHEDULE || '0 0 * * *';
const TIMEZONE = process.env.TIMEZONE || 'America/Chicago';

// Force stdout/stderr to blocking mode so the last log lines before a crash,
// OOM kill, or container restart actually make it to Railway logs (piped
// stdout is async-buffered by default and loses pending writes on SIGKILL).
try { process.stdout._handle && process.stdout._handle.setBlocking(true); } catch (_) {}
try { process.stderr._handle && process.stderr._handle.setBlocking(true); } catch (_) {}

function tsNow() {
  return new Date().toLocaleString('en-US', { timeZone: TIMEZONE, timeZoneName: 'short' });
}

process.on('uncaughtException', (err) => {
  console.error(`[${tsNow()}] uncaughtException:`, err && (err.stack || err.message || err));
});
process.on('unhandledRejection', (reason) => {
  console.error(`[${tsNow()}] unhandledRejection:`, reason && (reason.stack || reason.message || reason));
});
process.on('SIGTERM', () => {
  console.error(`[${tsNow()}] Received SIGTERM — process shutting down.`);
});
process.on('SIGINT', () => {
  console.error(`[${tsNow()}] Received SIGINT — process shutting down.`);
  process.exit(0);
});
process.on('exit', (code) => {
  console.error(`[${tsNow()}] process exit code=${code}`);
});

console.log('══════════════════════════════════════════════');
console.log('  Quo Daily Report Scheduler');
console.log('══════════════════════════════════════════════');
console.log(`  Schedule : ${SCHEDULE}`);
console.log(`  Timezone : ${TIMEZONE}`);
console.log(`  Started  : ${tsNow()}`);
console.log('══════════════════════════════════════════════\n');

if (!cron.validate(SCHEDULE)) {
  console.error(`Invalid cron expression: "${SCHEDULE}"`);
  process.exit(1);
}

cron.schedule(
  SCHEDULE,
  async () => {
    const ts = tsNow();
    console.log(`\n[${ts}] Cron triggered — starting daily reports (call + lead)...`);
    try {
      await runDailyReport();
      console.log(`[${tsNow()}] Daily report finished cleanly.`);
    } catch (err) {
      console.error(
        `[${tsNow()}] Daily report failed:`,
        err && (err.stack || err.message || err)
      );
    }
  },
  { timezone: TIMEZONE }
);

console.log('Scheduler running. Waiting for next trigger...');
console.log('(Press Ctrl+C to stop)\n');

// Keep the process alive and log a heartbeat every hour so you can
// confirm the server process is still running in your logs.
setInterval(() => {
  console.log(`[${tsNow()}] Heartbeat — scheduler alive. rss=${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`);
}, 60 * 60 * 1000);
