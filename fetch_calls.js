require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

// ── Config (module-level defaults, overridable via runExport options) ─────────

const API_KEY = process.env.QUO_API_KEY;

const PHONE_NUMBERS_FILTER = process.env.QUO_PHONE_NUMBERS
  ? process.env.QUO_PHONE_NUMBERS.split(',').map((s) => s.trim()).filter(Boolean)
  : null;

const CREATED_AFTER  = process.env.QUO_CREATED_AFTER?.trim()  || null;
const CREATED_BEFORE = process.env.QUO_CREATED_BEFORE?.trim() || null;
const MAX_RESULTS    = Math.min(Math.max(parseInt(process.env.QUO_MAX_RESULTS || '100', 10), 1), 100);
const OUTPUT_FILE    = 'quo_transcripts.csv';

const REQUEST_DELAY_MS = 120;

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeClient(apiKey) {
  return axios.create({
    baseURL: 'https://api.openphone.com',
    headers: { Authorization: apiKey },
  });
}

function cleanText(value) {
  if (value == null) return '';
  return String(value)
    .replace(/\r?\n|\r/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/"/g, '""')
    .trim();
}

function csvRow(fields) {
  return fields.map((f) => `"${cleanText(f)}"`).join(',');
}

// ── API functions ─────────────────────────────────────────────────────────────

async function listPhoneNumbers(client) {
  const res = await client.get('/v1/phone-numbers');
  return res.data.data || [];
}

function matchesFilter(pn, filters) {
  if (!filters?.length) return true;
  return filters.some(
    (f) =>
      pn.id === f ||
      pn.number === f ||
      pn.formattedNumber === f ||
      pn.name?.toLowerCase() === f.toLowerCase()
  );
}

async function fetchAllConversations(client, phoneNumberIds, cfg) {
  const conversations = [];
  let pageToken = null;
  let page = 0;

  do {
    page++;
    const params = { maxResults: cfg.maxResults };
    if (phoneNumberIds?.length)  params.phoneNumbers  = phoneNumberIds;
    if (cfg.createdAfter)        params.createdAfter  = cfg.createdAfter;
    if (cfg.createdBefore)       params.createdBefore = cfg.createdBefore;
    if (pageToken)               params.pageToken     = pageToken;

    const res = await client.get('/v1/conversations', { params });
    const batch = res.data.data || [];
    conversations.push(...batch);
    pageToken = res.data.nextPageToken || null;
    console.log(`  Conversations page ${page}: ${batch.length} (total: ${conversations.length})`);

    if (pageToken) await sleep(REQUEST_DELAY_MS);
  } while (pageToken);

  return conversations;
}

async function fetchCallsForConversation(client, phoneNumberId, participant, cfg) {
  const calls = [];
  let pageToken = null;

  do {
    const params = {
      phoneNumberId,
      participants: [participant],
      maxResults: cfg.maxResults,
    };
    if (cfg.createdAfter)  params.createdAfter  = cfg.createdAfter;
    if (cfg.createdBefore) params.createdBefore = cfg.createdBefore;
    if (pageToken)         params.pageToken     = pageToken;

    const res = await client.get('/v1/calls', { params });
    const batch = res.data.data || [];
    calls.push(...batch);
    pageToken = res.data.nextPageToken || null;

    if (pageToken) await sleep(REQUEST_DELAY_MS);
  } while (pageToken);

  return calls;
}

async function fetchTranscript(client, callId) {
  try {
    const res = await client.get(`/v1/call-transcripts/${callId}`);
    const data = res.data?.data;
    if (!data) return null;
    if (data.status === 'absent' || data.status === 'failed') return null;

    const dialogue = data.dialogue;
    if (!Array.isArray(dialogue) || dialogue.length === 0) return null;

    return dialogue.map((seg) => seg.content || '').filter(Boolean).join(' ');
  } catch (err) {
    if (err.response?.status === 404 || err.response?.status === 403) return null;
    throw err;
  }
}

async function fetchSummary(client, callId) {
  try {
    const res = await client.get(`/v1/call-summaries/${callId}`);
    const data = res.data?.data;
    if (!data) return '';
    if (data.status === 'absent' || data.status === 'failed') return '';

    const summary = data.summary;
    if (!summary) return '';
    if (Array.isArray(summary)) return summary.join(' ');
    return String(summary);
  } catch (err) {
    if (err.response?.status === 404 || err.response?.status === 403) return '';
    throw err;
  }
}

async function buildContactMap(client) {
  const map = {};
  let pageToken = null;
  let total = 0;

  do {
    const params = { maxResults: 50 };
    if (pageToken) params.pageToken = pageToken;

    const res = await client.get('/v1/contacts', { params });
    const batch = res.data.data || [];
    total += batch.length;

    for (const c of batch) {
      const df = c.defaultFields || {};
      const name = [df.firstName, df.lastName].filter(Boolean).join(' ') || df.company || '';
      if (!name) continue;
      for (const ph of df.phoneNumbers || []) {
        if (ph.value) map[ph.value] = name;
      }
    }

    pageToken = res.data.nextPageToken || null;
    if (pageToken) await sleep(REQUEST_DELAY_MS);
  } while (pageToken);

  console.log(`Loaded ${total} contacts (${Object.keys(map).length} with phone numbers).`);
  return map;
}

function extractInlineTranscript(call) {
  if (call.transcript && typeof call.transcript === 'string') return call.transcript;
  for (const messages of [call.messages, call.conversation?.messages]) {
    if (Array.isArray(messages) && messages.length > 0) {
      const text = messages.map((m) => m.text || m.content || m.body || '').filter(Boolean).join(' ');
      if (text) return text;
    }
  }
  return null;
}

function getExternalPhone(call, ownNumber) {
  const participants = call.participants || [];
  return participants.find((p) => p !== ownNumber) || participants[0] || '';
}

// ── Core export function ──────────────────────────────────────────────────────

/**
 * Fetches calls and returns structured data + CSV lines.
 * Can be called programmatically with options, or via main() from the CLI.
 *
 * @param {object} options
 * @param {string}   [options.apiKey]             - override QUO_API_KEY
 * @param {string[]} [options.phoneNumbersFilter] - override QUO_PHONE_NUMBERS
 * @param {string}   [options.createdAfter]        - override QUO_CREATED_AFTER
 * @param {string}   [options.createdBefore]       - override QUO_CREATED_BEFORE
 * @param {number}   [options.maxResults]          - override QUO_MAX_RESULTS
 * @returns {{ csvLines: string[], callData: object[], totalFetched: number, totalSaved: number }}
 */
async function runExport(options = {}) {
  const apiKey      = options.apiKey            ?? API_KEY;
  const pnFilter    = options.phoneNumbersFilter ?? PHONE_NUMBERS_FILTER;
  const cfg = {
    createdAfter:  options.createdAfter  ?? CREATED_AFTER,
    createdBefore: options.createdBefore ?? CREATED_BEFORE,
    maxResults:    options.maxResults    ?? MAX_RESULTS,
  };

  if (!apiKey) throw new Error('QUO_API_KEY is not set.');

  const client = makeClient(apiKey);

  // Resolve phone numbers
  let phoneNumbers = await listPhoneNumbers(client);

  if (pnFilter) {
    phoneNumbers = phoneNumbers.filter((pn) => matchesFilter(pn, pnFilter));
    if (phoneNumbers.length === 0) {
      throw new Error(`None of the specified QUO_PHONE_NUMBERS were found in the workspace.`);
    }
  }

  if (phoneNumbers.length === 0) throw new Error('No phone numbers found in the workspace.');

  const phoneNumberIds = phoneNumbers.map((pn) => pn.id);
  const phoneNumberMap = Object.fromEntries(
    phoneNumbers.map((pn) => [pn.id, { number: pn.number || pn.formattedNumber || '', name: pn.name || '' }])
  );

  console.log(
    `Processing ${phoneNumbers.length} line(s): ` +
    phoneNumbers.map((pn) => `${pn.name || pn.number} (${pn.number})`).join(', ')
  );

  // Load contacts
  console.log('\nLoading contacts...');
  let contactMap = {};
  try {
    contactMap = await buildContactMap(client);
  } catch (err) {
    console.warn('Could not load contacts:', err.response?.data?.message || err.message);
  }

  // Fetch conversations
  console.log('\nFetching all conversations...');
  const conversations = await fetchAllConversations(client, phoneNumberIds, cfg);
  console.log(`Found ${conversations.length} conversation(s) total.\n`);

  // Iterate conversations → calls → transcripts
  const csvLines = [csvRow(['timestamp', 'line', 'phone', 'contact', 'duration', 'summary', 'transcript', 'link'])];
  const callData = [];
  let totalFetched = 0;
  let totalSaved = 0;

  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i];
    const lineInfo  = phoneNumberMap[conv.phoneNumberId] || {};
    const ownNumber = lineInfo.number || '';
    const lineName  = lineInfo.name || ownNumber;
    const participant = (conv.participants || []).find((p) => p !== ownNumber);

    if (!participant) continue;

    process.stdout.write(`[${i + 1}/${conversations.length}] ${participant} ... `);

    let calls;
    try {
      calls = await fetchCallsForConversation(client, conv.phoneNumberId, participant, cfg);
    } catch (err) {
      console.log(`error: ${err.response?.data?.message || err.message}`);
      continue;
    }

    await sleep(REQUEST_DELAY_MS);
    totalFetched += calls.length;
    let savedThisConv = 0;

    for (const call of calls) {
      let transcript = extractInlineTranscript(call);
      if (!transcript) transcript = await fetchTranscript(client, call.id);
      if (!transcript || transcript.trim() === '') continue;

      const summary   = await fetchSummary(client, call.id);
      const timestamp = call.answeredAt || call.createdAt || '';
      const phone     = getExternalPhone(call, ownNumber);
      const contact   = contactMap[phone] || '';
      const duration  = call.duration ?? '';
      const link      = `https://my.openphone.com/inbox/${conv.phoneNumberId}/c/${conv.id}?at=${call.id}`;

      csvLines.push(csvRow([timestamp, lineName, phone, contact, duration, summary, transcript, link]));
      callData.push({ timestamp, line: lineName, phone, contact, duration, summary, transcript, link });
      totalSaved++;
      savedThisConv++;

      await sleep(REQUEST_DELAY_MS);
    }

    console.log(`${calls.length} calls, ${savedThisConv} transcripts`);
  }

  return { csvLines, callData, totalFetched, totalSaved };
}

// ── Standalone CLI entry point ─────────────────────────────────────────────────

async function main() {
  if (!API_KEY) {
    console.error('Error: QUO_API_KEY is not set. Copy .env.example to .env and add your key.');
    process.exit(1);
  }

  try {
    const { csvLines, totalFetched, totalSaved } = await runExport();
    fs.writeFileSync(OUTPUT_FILE, csvLines.join('\n'), 'utf8');
    console.log('\n════════════════════════════════');
    console.log(`Total calls fetched:     ${totalFetched}`);
    console.log(`Total transcripts saved: ${totalSaved}`);
    console.log(`Output file:             ${OUTPUT_FILE}`);
  } catch (err) {
    console.error('\nError:', err.response?.data || err.message);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { runExport };
