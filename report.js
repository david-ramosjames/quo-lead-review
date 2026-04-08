require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');
const nodemailer = require('nodemailer');
const OpenAI = require('openai');
const { runExport } = require('./fetch_calls');
const {
  generateDailyCallReportPrompt,
  generateDailyLeadReportPrompt,
} = require('./prompts');
const { fetchSlackMessages, formatSlackForPrompt } = require('./slack');
const { getLeadPipelineText } = require('./sheets');

// ── Config ────────────────────────────────────────────────────────────────────

const OPENAI_API_KEY  = process.env.OPENAI_API_KEY;
const OPENAI_MODEL    = process.env.OPENAI_MODEL || 'gpt-5-mini';
const OPENAI_MAX_COMPLETION_TOKENS = parseInt(
  process.env.OPENAI_MAX_COMPLETION_TOKENS || '28000',
  10
);
/** Call report uses full transcripts — allow a higher cap via env. */
const OPENAI_CALL_REPORT_MAX_TOKENS = parseInt(
  process.env.OPENAI_CALL_REPORT_MAX_COMPLETION_TOKENS ||
    String(Math.max(OPENAI_MAX_COMPLETION_TOKENS, 48000)),
  10
);
const OPENAI_LEAD_REPORT_MAX_TOKENS = parseInt(
  process.env.OPENAI_LEAD_REPORT_MAX_COMPLETION_TOKENS ||
    String(OPENAI_MAX_COMPLETION_TOKENS),
  10
);
const OPENAI_REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT || 'low';
const COMPANY_NAME    = process.env.COMPANY_NAME || 'Ramos James Law, PLLC';
const TIMEZONE        = process.env.TIMEZONE || 'America/Chicago';
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL   = process.env.SLACK_CHANNEL || 'lead-calls';

const GOOGLE_SHEETS_ID    = process.env.GOOGLE_SHEETS_ID;
// Blank = entire first worksheet. Otherwise e.g. A:ZZ, or 'Master View'!A:ZZ for a specific tab.
const GOOGLE_SHEETS_RANGE = (process.env.GOOGLE_SHEETS_RANGE ?? '').trim();

const EMAIL_FROM = process.env.EMAIL_FROM;
const EMAIL_TO   = process.env.EMAIL_TO?.split(',').map((e) => e.trim()).filter(Boolean) || [];
const SMTP_HOST  = process.env.SMTP_HOST;
const SMTP_PORT  = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER  = process.env.SMTP_USER;
const SMTP_PASS  = process.env.SMTP_PASS;

// ── Date helpers ──────────────────────────────────────────────────────────────

/**
 * Yesterday 00:00–24:00 in TIMEZONE — same window for Quo API and Slack.
 */
function getYesterdayRange() {
  const end   = DateTime.now().setZone(TIMEZONE).startOf('day');
  const start = end.minus({ days: 1 });
  return {
    createdAfter:  start.toUTC().toISO(),
    createdBefore: end.toUTC().toISO(),
  };
}

/** Human-readable range for prompts (e.g. "Mon, Apr 1, 2026 (America/Chicago, full calendar day)") */
function buildReportRangeLabel(createdAfter) {
  const dt = DateTime.fromISO(createdAfter, { zone: 'utc' }).setZone(TIMEZONE);
  return `${dt.toFormat('ccc, LLL d, yyyy')} (${TIMEZONE}, full calendar day)`;
}

function formatDateLabel(iso) {
  return new Date(iso).toLocaleDateString('en-US', {
    timeZone: TIMEZONE,
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatDayOfWeek(iso) {
  return new Date(iso).toLocaleDateString('en-US', {
    timeZone: TIMEZONE,
    weekday: 'long',
  });
}

function formatTimestamp(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', {
    timeZone: TIMEZONE,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

// ── Prompt data builders ──────────────────────────────────────────────────────

function buildLineBreakdown(callData) {
  const byLine = {};
  for (const c of callData) byLine[c.line] = (byLine[c.line] || 0) + 1;
  return Object.entries(byLine)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');
}

function buildContactBreakdown(callData) {
  const known   = callData.filter((c) => c.contact && c.contact.trim()).length;
  const unknown = callData.length - known;
  return `${known} known, ${unknown} new/unknown`;
}

/** Daily Call Report — full transcript + Quo link per call. */
function buildCallBlocksFullTranscript(callData) {
  return callData
    .map((c, i) => {
      const who       = c.contact?.trim() || `(unknown — ${c.phone})`;
      const durMin    = Math.round((Number(c.duration) || 0) / 60);
      const timestamp = formatTimestamp(c.timestamp);
      const transcript = c.transcript?.trim()
        ? c.transcript
        : '(no transcript)';

      return [
        `=== CALL [${i + 1}] ===`,
        `LINE: ${c.line} | CONTACT: ${who} | PHONE: ${c.phone || ''} | DURATION: ${durMin} min | TIME: ${timestamp}`,
        `LINK: ${c.link || ''}`,
        `SUMMARY: ${c.summary || '(no summary)'}`,
        `TRANSCRIPT (full):\n${transcript}`,
        '---',
      ].join('\n');
    })
    .join('\n');
}

/** Daily Lead Report — metadata + summary + link only (no transcript). */
function buildCallSummaryOnlyLines(callData) {
  return callData
    .map((c, i) => {
      const who       = c.contact?.trim() || `(unknown — ${c.phone})`;
      const durMin    = Math.round((Number(c.duration) || 0) / 60);
      const timestamp = formatTimestamp(c.timestamp);

      return [
        `[${i + 1}] LINE: ${c.line} | CONTACT: ${who} | PHONE: ${c.phone || ''} | DURATION: ${durMin} min | TIME: ${timestamp}`,
        `LINK: ${c.link || ''}`,
        `SUMMARY: ${c.summary || '(no summary)'}`,
        '---',
      ].join('\n');
    })
    .join('\n');
}

// ── LLM analysis ──────────────────────────────────────────────────────────────

/** GPT-5 / o-series may return string or content-parts array; reasoning can burn the whole token budget. */
function extractChatCompletionText(choice) {
  const msg = choice?.message;
  if (!msg) return { text: '', refusal: null, finishReason: choice?.finish_reason };

  if (msg.refusal) {
    return { text: '', refusal: msg.refusal, finishReason: choice?.finish_reason };
  }

  const c = msg.content;
  if (c == null) return { text: '', refusal: null, finishReason: choice?.finish_reason };
  if (typeof c === 'string') return { text: c.trim(), refusal: null, finishReason: choice?.finish_reason };

  if (Array.isArray(c)) {
    const parts = c
      .map((p) => {
        if (p.type === 'text') return p.text || '';
        return '';
      })
      .join('');
    return { text: parts.trim(), refusal: null, finishReason: choice?.finish_reason };
  }

  return { text: '', refusal: null, finishReason: choice?.finish_reason };
}

async function runChatCompletion(prompt, maxCompletionTokens, labelForLogs = 'OpenAI') {
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

  const body = {
    model: OPENAI_MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_completion_tokens: maxCompletionTokens,
  };

  if (/^gpt-5/i.test(OPENAI_MODEL) || /^o\d/i.test(OPENAI_MODEL)) {
    body.reasoning_effort = OPENAI_REASONING_EFFORT;
  }

  let res;
  try {
    res = await openai.chat.completions.create(body);
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message || '';
    if (body.reasoning_effort && /reasoning_effort|unsupported/i.test(msg)) {
      delete body.reasoning_effort;
      res = await openai.chat.completions.create(body);
    } else {
      throw err;
    }
  }

  const choice = res.choices[0];
  const { text, refusal, finishReason } = extractChatCompletionText(choice);

  if (!text) {
    const usage = res.usage;
    console.warn(`  ${labelForLogs} returned no visible assistant text.`, {
      finish_reason: finishReason,
      refusal: refusal || undefined,
      usage,
    });
    const hint =
      'The model used the token budget before producing visible text (common with GPT-5 + reasoning). ' +
      'Raise OPENAI_CALL_REPORT_MAX_COMPLETION_TOKENS / OPENAI_LEAD_REPORT_MAX_COMPLETION_TOKENS or OPENAI_MAX_COMPLETION_TOKENS, or set OPENAI_REASONING_EFFORT=low in .env.';
    return refusal
      ? `**Model refused:** ${refusal}\n\n${hint}`
      : `**No report body returned** (finish_reason: ${finishReason || 'unknown'}).\n\n${hint}`;
  }

  return text;
}

async function generateDailyCallReportAnalysis(callData, totalCalls, createdAfter, reportRangeLabel) {
  const totalDurationMin = Math.round(
    callData.reduce((s, c) => s + (Number(c.duration) || 0), 0) / 60
  );

  const prompt = generateDailyCallReportPrompt({
    COMPANY_NAME,
    dateLabel: formatDateLabel(createdAfter),
    dayOfWeek: formatDayOfWeek(createdAfter),
    reportRangeLabel,
    callData,
    totalCalls,
    totalDurationMin,
    lineBreakdown: buildLineBreakdown(callData),
    contactBreakdown: buildContactBreakdown(callData),
    callBlocksFullTranscript: buildCallBlocksFullTranscript(callData),
  });

  return runChatCompletion(prompt, OPENAI_CALL_REPORT_MAX_TOKENS, 'Daily Call Report');
}

async function generateDailyLeadReportAnalysis(
  callData,
  totalCalls,
  createdAfter,
  slackText,
  sheetText,
  reportRangeLabel,
  slackMessageCount,
  sheetRowCount
) {
  const prompt = generateDailyLeadReportPrompt({
    COMPANY_NAME,
    dateLabel: formatDateLabel(createdAfter),
    dayOfWeek: formatDayOfWeek(createdAfter),
    reportRangeLabel,
    slackMessageCount,
    sheetRowCount,
    callData,
    totalCalls,
    summaryLinesOnly: buildCallSummaryOnlyLines(callData),
    slackMessages: slackText,
    leadPipeline: sheetText,
  });

  return runChatCompletion(prompt, OPENAI_LEAD_REPORT_MAX_TOKENS, 'Daily Lead Report');
}

// ── Email ─────────────────────────────────────────────────────────────────────

function markdownToHtml(md) {
  return md
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
      '<a href="$2" style="color:#c0392b;font-weight:bold;text-decoration:none" target="_blank">$1</a>'
    )
    .replace(/^## (.+)$/gm,      '<h2 style="color:#1a1a2e;margin-top:28px;margin-bottom:8px;font-size:17px">$1</h2>')
    .replace(/^### (.+)$/gm,     '<h3 style="color:#333;margin-top:16px;margin-bottom:4px">$1</h3>')
    .replace(/\*\*(.+?)\*\*/g,   '<strong>$1</strong>')
    .replace(/^(\d+)\. (.+)$/gm, '<li style="margin:4px 0">$2</li>')
    .replace(/^[-•] (.+)$/gm,    '<li style="margin:4px 0">$1</li>')
    .replace(/(<li[^>]*>[\s\S]*?<\/li>\n?)+/g, (m) =>
      `<ul style="margin:8px 0;padding-left:20px">${m}</ul>`)
    .replace(/\|(.+)\|/g, (row) => {
      const cells = row.split('|').filter(Boolean);
      const isHeader = cells.some((c) => /^\s*-+\s*$/.test(c));
      if (isHeader) return '';
      const tag = cells[0]?.trim().match(/^[A-Z]/) ? 'th' : 'td';
      return '<tr>' + cells.map((c) =>
        `<${tag} style="padding:6px 12px;border:1px solid #e0e0e0;text-align:left">${c.trim()}</${tag}>`
      ).join('') + '</tr>';
    })
    .replace(/(<tr>[\s\S]*?<\/tr>\n?)+/g, (m) =>
      `<table style="border-collapse:collapse;width:100%;margin:12px 0;font-size:14px">${m}</table>`)
    .replace(/\n{2,}/g, '</p><p style="margin:8px 0">')
    .replace(/\n/g, '<br>');
}

function buildEmailHtml(analysis, stats, dateLabel, variant = 'lead') {
  const totalMinHr = stats.totalMinutes >= 60
    ? `${Math.floor(stats.totalMinutes / 60)}h ${stats.totalMinutes % 60}m`
    : `${stats.totalMinutes}m`;

  const title =
    variant === 'call'
      ? '📞 Daily Call Report'
      : '🎯 Daily Lead Report';
  const emojiBar = variant === 'call' ? '#2563eb' : '#0d9488';

  const sheetShown =
    stats.sheetRows != null && Number.isFinite(stats.sheetRows)
      ? String(stats.sheetRows)
      : '—';

  const metricsRow =
    variant === 'call'
      ? `<table style="width:100%;border-collapse:collapse">
      <tr>
        <td style="padding:10px 16px;background:#eff6ff;border-radius:6px;text-align:center;border:1px solid #bfdbfe">
          <div style="font-size:28px;font-weight:bold;color:#1a1a2e">${stats.totalFetched}</div>
          <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.5px">Total calls</div>
        </td>
        <td style="width:12px"></td>
        <td style="padding:10px 16px;background:#eff6ff;border-radius:6px;text-align:center;border:1px solid #bfdbfe">
          <div style="font-size:28px;font-weight:bold;color:#1a1a2e">${stats.totalSaved}</div>
          <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.5px">Transcripts</div>
        </td>
        <td style="width:12px"></td>
        <td style="padding:10px 16px;background:#eff6ff;border-radius:6px;text-align:center;border:1px solid #bfdbfe">
          <div style="font-size:28px;font-weight:bold;color:#1a1a2e">${totalMinHr}</div>
          <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.5px">Talk time</div>
        </td>
      </tr>
    </table>`
      : `<p style="margin:0 0 10px;font-size:13px;color:#444;font-style:italic">Lead flow across three sources — not phone QA metrics.</p>
    <table style="width:100%;border-collapse:collapse">
      <tr>
        <td style="padding:12px 14px;background:#f0fdfa;border-radius:6px;text-align:center;border:1px solid #99f6e4">
          <div style="font-size:11px;color:#0f766e;text-transform:uppercase;letter-spacing:.5px;font-weight:bold">Quo · phone</div>
          <div style="font-size:26px;font-weight:bold;color:#134e4a">${stats.totalFetched}</div>
          <div style="font-size:11px;color:#666">calls in window</div>
        </td>
        <td style="width:10px"></td>
        <td style="padding:12px 14px;background:#fffbeb;border-radius:6px;text-align:center;border:1px solid #fde68a">
          <div style="font-size:11px;color:#b45309;text-transform:uppercase;letter-spacing:.5px;font-weight:bold">Slack</div>
          <div style="font-size:26px;font-weight:bold;color:#78350f">${stats.slackMessages ?? '—'}</div>
          <div style="font-size:11px;color:#666">#lead-calls msgs</div>
        </td>
        <td style="width:10px"></td>
        <td style="padding:12px 14px;background:#faf5ff;border-radius:6px;text-align:center;border:1px solid #e9d5ff">
          <div style="font-size:11px;color:#6b21a8;text-transform:uppercase;letter-spacing:.5px;font-weight:bold">Sheet</div>
          <div style="font-size:26px;font-weight:bold;color:#581c87">${sheetShown}</div>
          <div style="font-size:11px;color:#666">pipeline rows</div>
        </td>
      </tr>
    </table>`;

  const footerNote =
    variant === 'call'
      ? `Full transcript CSV attached &nbsp;·&nbsp; Generated ${new Date().toLocaleString('en-US', { timeZone: TIMEZONE, timeZoneName: 'short' })}`
      : `No CSV on this message — transcript export is on the 📞 Daily Call Report email &nbsp;·&nbsp; Generated ${new Date().toLocaleString('en-US', { timeZone: TIMEZONE, timeZoneName: 'short' })}`;

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Georgia,serif;max-width:700px;margin:0 auto;padding:24px;color:#333;background:#f5f5f5">
  <div style="background:#1a1a2e;color:#fff;padding:24px 32px;border-radius:8px 8px 0 0">
    <h1 style="margin:0;font-size:20px;letter-spacing:.3px">${title}</h1>
    <p style="margin:6px 0 0;opacity:.75;font-size:13px">${COMPANY_NAME} · ${dateLabel}</p>
  </div>
  <div style="background:#fff;padding:16px 32px 12px;border:1px solid #e0e0e0;border-top:3px solid ${emojiBar}">
    ${metricsRow}
  </div>
  <div style="background:#fff;padding:8px 32px 32px;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px;line-height:1.75">
    <div style="margin:0">${analysis.trim() ? markdownToHtml(analysis) : '<p><em>(No analysis body — check console warning from OpenAI step.)</em></p>'}</div>
  </div>
  <p style="font-size:11px;color:#aaa;text-align:center;margin-top:16px">
    ${footerNote}
  </p>
</body>
</html>`;
}

function createMailTransporter() {
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    // Explicit timeouts so a stuck SMTP connection fails fast and can be retried
    // instead of hanging forever (nodemailer defaults are lenient).
    connectionTimeout: 30_000,
    greetingTimeout:   30_000,
    socketTimeout:     60_000,
    pool: false,
    // Uncomment for verbose SMTP trace when debugging:
    // logger: true,
    // debug: true,
  });
}

function isTransientSmtpError(err) {
  const code = err && (err.code || err.errno);
  if (!code) return false;
  return [
    'ETIMEDOUT',
    'ESOCKET',
    'ECONNECTION',
    'ECONNRESET',
    'ECONNREFUSED',
    'EDNS',
    'EAI_AGAIN',
    'EPROTOCOL',
  ].includes(code);
}

/**
 * Hard outer deadline so sendMail() can never hang the whole job even if
 * nodemailer's own timeouts fail to fire (has happened during STARTTLS).
 */
function withHardTimeout(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} hard timeout after ${ms}ms`)),
      ms
    );
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function sendEmail({ htmlBody, plainText, subject, attachments = [] }) {
  const mail = {
    from: EMAIL_FROM,
    to: EMAIL_TO.join(', '),
    subject,
    text: plainText,
    html: htmlBody,
  };
  if (attachments.length) mail.attachments = attachments;

  const MAX_ATTEMPTS = 4;
  const HARD_TIMEOUT_MS = 120_000; // 2 min absolute cap per attempt
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const transporter = createMailTransporter();
    try {
      if (attempt === 1) {
        // Verify connectivity first so a dead SMTP host fails with a clear
        // error instead of looking like a sendMail hang.
        await withHardTimeout(transporter.verify(), 45_000, 'SMTP verify');
      }
      await withHardTimeout(
        transporter.sendMail(mail),
        HARD_TIMEOUT_MS,
        'SMTP sendMail'
      );
      return;
    } catch (err) {
      lastErr = err;
      const transient =
        isTransientSmtpError(err) || /timeout/i.test(err.message || '');
      console.warn(
        `  SMTP attempt ${attempt}/${MAX_ATTEMPTS} failed: ${err.code || ''} ${err.message || err}`
      );
      if (!transient || attempt === MAX_ATTEMPTS) {
        throw err;
      }
      const backoffMs = 2000 * 2 ** (attempt - 1); // 2s, 4s, 8s
      console.warn(`  Retrying in ${backoffMs / 1000}s...`);
      await new Promise((r) => setTimeout(r, backoffMs));
    } finally {
      try { transporter.close(); } catch (_) { /* ignore */ }
    }
  }
  throw lastErr;
}

// ── Main report runner ────────────────────────────────────────────────────────

async function runDailyReport() {
  const { createdAfter, createdBefore } = getYesterdayRange();
  const dateLabel     = formatDateLabel(createdAfter);
  const dayOfWeek     = formatDayOfWeek(createdAfter);
  const rangeLabel    = buildReportRangeLabel(createdAfter);
  const slackThreads  = process.env.SLACK_INCLUDE_THREADS !== 'false';

  console.log(`\n${'═'.repeat(52)}`);
  console.log(`  Daily reports: ${dayOfWeek}, ${dateLabel}`);
  console.log(`  Window: ${rangeLabel}`);
  console.log('═'.repeat(52));

  // 1. Fetch calls (same calendar window as Slack)
  console.log('\n[1/8] Fetching calls...\n');
  const { csvLines, callData, totalFetched, totalSaved } = await runExport({
    createdAfter,
    createdBefore,
  });

  const totalMinutes = Math.round(
    callData.reduce((s, c) => s + (Number(c.duration) || 0), 0) / 60
  );
  const stats = {
    totalFetched,
    totalSaved,
    totalMinutes,
    slackMessages: 0,
    sheetRows: null,
  };

  // 2. Save daily CSV
  console.log('\n[2/8] Saving daily CSV...');
  const csvFilename = `quo_daily_${createdAfter.slice(0, 10)}.csv`;
  fs.writeFileSync(csvFilename, csvLines.join('\n'), 'utf8');
  console.log(`  ${csvFilename} (${totalFetched} calls fetched, ${totalSaved} transcripts)`);

  // 3. Slack — full day, all pages, no message cap; optional threads
  console.log(`\n[3/8] Fetching #${SLACK_CHANNEL} (same window as calls; threads=${slackThreads})...`);
  let slackText = '(Slack not configured — set SLACK_BOT_TOKEN to enable.)';
  if (SLACK_BOT_TOKEN) {
    try {
      const slackMessages = await fetchSlackMessages(
        SLACK_BOT_TOKEN,
        SLACK_CHANNEL,
        createdAfter,
        createdBefore,
        { includeThreads: slackThreads }
      );
      stats.slackMessages = slackMessages.length;
      slackText = formatSlackForPrompt(slackMessages, TIMEZONE, rangeLabel);
      console.log(`  Fetched ${slackMessages.length} top-level message(s) (all pages in range).`);
    } catch (err) {
      slackText = `(Could not fetch Slack messages: ${err.message})`;
      console.warn(`  Warning: ${err.message}`);
    }
  } else {
    console.log('  Skipped (no SLACK_BOT_TOKEN).');
  }

  // 4. Google Sheets — system of record
  console.log('\n[4/8] Fetching lead pipeline from Google Sheets...');
  let sheetText = '(Google Sheets not configured — set GOOGLE_SHEETS_ID and OAuth; run setup-sheets-auth.js.)';
  if (GOOGLE_SHEETS_ID) {
    try {
      const { text, totalRows } = await getLeadPipelineText(
        GOOGLE_SHEETS_ID,
        GOOGLE_SHEETS_RANGE,
        undefined,
        { callData, slackText }
      );
      sheetText = text;
      stats.sheetRows = totalRows;
      console.log(`  Fetched ${totalRows} row(s) from sheet.`);
    } catch (err) {
      sheetText = `(Could not fetch Google Sheet: ${err.message})`;
      console.warn(`  Warning: ${err.message}`);
    }
  } else {
    console.log('  Skipped (not configured).');
  }

  // 4–5. LLM — Daily Call Report (full transcripts) + Daily Lead Report (summaries + Slack + sheet)
  let callAnalysis = '';
  let leadAnalysis = '';
  if (!OPENAI_API_KEY) {
    callAnalysis =
      leadAnalysis =
        'OPENAI_API_KEY is not configured — skipping AI analysis.';
    console.log('\n[5/8] Skipped Daily Call Report (no OPENAI_API_KEY).');
    console.log('\n[6/8] Skipped Daily Lead Report (no OPENAI_API_KEY).');
  } else {
    console.log('\n[5/8] Generating Daily Call Report (full transcripts)...');
    callAnalysis = await generateDailyCallReportAnalysis(
      callData,
      totalFetched,
      createdAfter,
      rangeLabel
    );
    console.log('  Done.');

    console.log('\n[6/8] Generating Daily Lead Report (summaries + Slack + sheet)...');
    leadAnalysis = await generateDailyLeadReportAnalysis(
      callData,
      totalFetched,
      createdAfter,
      slackText,
      sheetText,
      rangeLabel,
      stats.slackMessages,
      stats.sheetRows
    );
    console.log('  Done.');
  }

  // Persist analyses to disk BEFORE touching email. If the process is killed
  // during email sending (OOM, SIGTERM, nodemailer hang) we still have the
  // day's reports on disk and can resend manually.
  const datePrefix   = createdAfter.slice(0, 10);
  const callOutPath  = `quo_daily_call_report_${datePrefix}.md`;
  const leadOutPath  = `quo_daily_lead_report_${datePrefix}.md`;
  try {
    fs.writeFileSync(callOutPath, callAnalysis || '', 'utf8');
    fs.writeFileSync(leadOutPath, leadAnalysis || '', 'utf8');
    console.log(
      `  Saved analyses to disk: ${callOutPath} (${(callAnalysis || '').length} chars), ${leadOutPath} (${(leadAnalysis || '').length} chars)`
    );
  } catch (err) {
    console.warn(`  Could not persist analyses to disk: ${err.message}`);
  }

  // 7–8. Email — Call Report includes CSV; Lead Report has no attachment
  if (!EMAIL_TO.length || !SMTP_HOST) {
    console.log('\n[7/8] Email not configured — printing reports:\n');
    console.log('\n--- Daily Call Report ---\n');
    console.log(callAnalysis);
    console.log('\n--- Daily Lead Report ---\n');
    console.log(leadAnalysis);
  } else {
    console.log(
      `\n  Email config: host=${SMTP_HOST} port=${SMTP_PORT} secure=${SMTP_PORT === 465} from=${EMAIL_FROM} to=${EMAIL_TO.join(',')}`
    );

    console.log('\n[7/8] Building Daily Call Report email body...');
    const callSubject = `📞 Daily Call Report — ${dayOfWeek}, ${dateLabel}`;
    const callHtml    = buildEmailHtml(callAnalysis, stats, dateLabel, 'call');
    console.log(`  HTML body built (${callHtml.length} chars).`);

    console.log('[7/8] Sending Daily Call Report email (with CSV)...');
    try {
      await sendEmail({
        htmlBody: callHtml,
        plainText: callAnalysis,
        subject: callSubject,
        attachments: [
          { filename: path.basename(csvFilename), path: csvFilename },
        ],
      });
      console.log(`  Sent to: ${EMAIL_TO.join(', ')}`);
    } catch (err) {
      console.error(
        `  Daily Call Report email FAILED: ${err.code || ''} ${err.message || err}`
      );
      if (err.response) console.error(`  SMTP response: ${err.response}`);
    }

    console.log('\n[8/8] Building Daily Lead Report email body...');
    const leadSubject = `🎯 Daily Lead Report — ${dayOfWeek}, ${dateLabel}`;
    const leadHtml    = buildEmailHtml(leadAnalysis, stats, dateLabel, 'lead');
    console.log(`  HTML body built (${leadHtml.length} chars).`);

    console.log('[8/8] Sending Daily Lead Report email (no CSV)...');
    try {
      await sendEmail({
        htmlBody: leadHtml,
        plainText: leadAnalysis,
        subject: leadSubject,
        attachments: [],
      });
      console.log(`  Sent to: ${EMAIL_TO.join(', ')}`);
    } catch (err) {
      console.error(
        `  Daily Lead Report email FAILED: ${err.code || ''} ${err.message || err}`
      );
      if (err.response) console.error(`  SMTP response: ${err.response}`);
    }
  }

  console.log(`\n${'═'.repeat(52)}`);
  console.log('Done.');
  return { csvFilename, callAnalysis, leadAnalysis, stats };
}

if (require.main === module) {
  runDailyReport().catch((err) => {
    console.error('\nError:', err.response?.data || err.message);
    process.exit(1);
  });
}

module.exports = { runDailyReport };
