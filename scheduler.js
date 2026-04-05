require('dotenv').config();
const cron = require('node-cron');
const { runDailyReport } = require('./report');

// Default: every day at midnight — report covers the previous day's calls
// Override with CRON_SCHEDULE env var if needed (standard cron syntax)
const SCHEDULE = process.env.CRON_SCHEDULE || '0 0 * * *';
const TIMEZONE = process.env.TIMEZONE || 'America/Chicago';

console.log('══════════════════════════════════════════════');
console.log('  Quo Daily Report Scheduler');
console.log('══════════════════════════════════════════════');
console.log(`  Schedule : ${SCHEDULE}`);
console.log(`  Timezone : ${TIMEZONE}`);
console.log(`  Started  : ${new Date().toLocaleString('en-US', { timeZone: TIMEZONE, timeZoneName: 'short' })}`);
console.log('══════════════════════════════════════════════\n');

if (!cron.validate(SCHEDULE)) {
  console.error(`Invalid cron expression: "${SCHEDULE}"`);
  process.exit(1);
}

cron.schedule(
  SCHEDULE,
  async () => {
    const ts = new Date().toLocaleString('en-US', { timeZone: TIMEZONE, timeZoneName: 'short' });
    console.log(`\n[${ts}] Cron triggered — starting daily reports (call + lead)...`);
    try {
      await runDailyReport();
    } catch (err) {
      console.error(`[${ts}] Daily report failed:`, err.message);
    }
  },
  { timezone: TIMEZONE }
);

console.log('Scheduler running. Waiting for next trigger...');
console.log('(Press Ctrl+C to stop)\n');

// Keep the process alive and log a heartbeat every hour so you can
// confirm the server process is still running in your logs.
setInterval(() => {
  const ts = new Date().toLocaleString('en-US', { timeZone: TIMEZONE, timeZoneName: 'short' });
  console.log(`[${ts}] Heartbeat — scheduler alive.`);
}, 60 * 60 * 1000);
