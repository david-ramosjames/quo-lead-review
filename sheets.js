const { google } = require('googleapis');
const { buildAutomatedSheetMatches } = require('./sheet_reconcile');

/**
 * Creates an authenticated Google Sheets client using OAuth 2.0 refresh token.
 * Run setup-sheets-auth.js once to obtain the refresh token.
 */
function makeAuthClient() {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Google Sheets auth not configured. Run: node setup-sheets-auth.js'
    );
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return oauth2Client;
}

/** Wrap tab title for A1 notation (spaces / specials need single quotes). */
function quoteSheetTitle(title) {
  return `'${String(title).replace(/'/g, "''")}'`;
}

/**
 * Empty range → entire first worksheet. Otherwise uses your string as-is (e.g. `A:Z`, `'Master View'!A:ZZ`).
 */
async function resolveValuesRange(spreadsheetId, rangeInput, sheetsApi) {
  const trimmed = (rangeInput ?? '').trim();
  if (trimmed) return trimmed;

  const sheets = sheetsApi || google.sheets({ version: 'v4', auth: makeAuthClient() });
  const meta   = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties.title',
  });
  const title = meta.data.sheets?.[0]?.properties?.title;
  if (!title) throw new Error('Spreadsheet has no worksheets.');
  return quoteSheetTitle(title);
}

/**
 * Fetches cell values. Pass empty rangeInput to read the entire first tab.
 */
async function fetchSheetData(spreadsheetId, rangeInput) {
  const auth   = makeAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });
  const range  = await resolveValuesRange(spreadsheetId, rangeInput, sheets);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    valueRenderOption: 'FORMATTED_VALUE',
  });

  return res.data.values || [];
}

/** "E" → 4, "F" → 5, "K" → 10, "AA" → 26 */
function columnLettersToIndex(letters) {
  const up = String(letters || 'A').toUpperCase().replace(/[^A-Z]/g, '') || 'A';
  let n = 0;
  for (let i = 0; i < up.length; i++) {
    n = n * 26 + (up.charCodeAt(i) - 64);
  }
  return n - 1;
}

function sheetMatchColumnsFromEnv() {
  return {
    name:    columnLettersToIndex(process.env.GOOGLE_SHEETS_NAME_COL || 'E'),
    phone:   columnLettersToIndex(process.env.GOOGLE_SHEETS_PHONE_COL || 'F'),
    status:  columnLettersToIndex(process.env.GOOGLE_SHEETS_STATUS_COL || 'K'),
    consult: columnLettersToIndex(process.env.GOOGLE_SHEETS_CONSULT_COL || 'L'),
  };
}

/** 0-based column index → Excel column letter(s) (A, B, … Z, AA, …) */
function columnIndexToName(index) {
  let result = '';
  let n = index + 1;
  while (n > 0) {
    n -= 1;
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result;
}

/**
 * Builds unique header keys. Duplicate or "Blank" headers were collapsing
 * into one object key — data was silently dropped and the LLM thought rows were incomplete.
 */
function uniqueHeaders(headerRow) {
  const seen = new Map();
  return headerRow.map((cell, i) => {
    let raw = String(cell ?? '').trim();
    if (!raw || /^blank$/i.test(raw)) {
      raw = `Column ${columnIndexToName(i)}`;
    }
    const count = (seen.get(raw) || 0) + 1;
    seen.set(raw, count);
    return count === 1 ? raw : `${raw} (${count})`;
  });
}

/**
 * Converts raw sheet rows into objects keyed by the header row.
 */
function rowsToObjects(rows) {
  if (rows.length < 2) return [];
  const headers = uniqueHeaders(rows[0]);
  return rows
    .slice(1)
    .filter((row) => row.some((cell) => String(cell ?? '').trim() !== ''))
    .map((row) =>
      Object.fromEntries(headers.map((h, i) => [h, String(row[i] ?? '').trim()]))
    );
}

/** Order these first per row so the model always sees identity + status fields. */
const PRIORITY_HEADERS = [
  'Lead Name',
  'Phone Number',
  'Email',
  'Lead Source',
  'Source Type',
  'Case Type',
  'Lead Status',
  'Consultation',
  'Consultation Date',
  'Desired Case',
  'Signed Case',
  'Case Number',
  'Date Signed',
  'Input by',
  'Date',
];

function sortHeadersForPrompt(headers) {
  const rank = (h) => {
    for (let i = 0; i < PRIORITY_HEADERS.length; i++) {
      const p = PRIORITY_HEADERS[i];
      if (h === p || h.startsWith(`${p} (`)) return i;
    }
    return 1000;
  };
  return [...headers].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return a.localeCompare(b);
  });
}

/**
 * One line per data row using ONLY fixed spreadsheet columns (default E, F, K, L).
 * Avoids header-name confusion entirely.
 */
function formatSheetFixedColumns(rows, maxRows = Infinity) {
  if (!rows?.length || rows.length < 2) return '(No data found in the sheet.)';

  const {
    name: iName,
    phone: iPhone,
    status: iStatus,
    consult: iConsult,
  } = sheetMatchColumnsFromEnv();

  const data = rows
    .slice(1)
    .map((row, i) => ({
      row,
      sheetRow: i + 2, // 1-based sheet row (row 1 = headers)
    }))
    .filter(({ row }) => row.some((cell) => String(cell ?? '').trim() !== ''));

  const unlimited =
    !Number.isFinite(maxRows) || maxRows <= 0 || maxRows >= data.length;
  const sample    = unlimited ? data : data.slice(0, maxRows);
  const truncated = !unlimited && data.length > maxRows;

  const nameL    = columnIndexToName(iName);
  const phoneL   = columnIndexToName(iPhone);
  const statusL  = columnIndexToName(iStatus);
  const consultL = columnIndexToName(iConsult);

  const lines = [
    'LEAD PIPELINE — use ONLY these cell positions (ignore row-1 header labels):',
    `• Column ${nameL} = Lead Name  •  Column ${phoneL} = Phone Number  •  Column ${statusL} = Lead Status  •  Column ${consultL} = Consultation (Y/N)`,
    'Match Quo/Slack to a row by: (1) same 10-digit phone, and/or (2) same person name (fuzzy OK).',
    'Do not claim "not on sheet" if any row matches on phone or clear name.',
    '',
  ];

  for (let i = 0; i < sample.length; i++) {
    const { row: r, sheetRow } = sample[i];
    const nm = String(r[iName] ?? '').trim();
    const ph = String(r[iPhone] ?? '').trim();
    const st = String(r[iStatus] ?? '').trim();
    const cn = String(r[iConsult] ?? '').trim();
    lines.push(
      `[sheet row ${sheetRow}] ${nameL}:"${nm}" | ${phoneL}:"${ph}" | ${statusL}:"${st}" | ${consultL}:"${cn}"`
    );
  }

  return (
    lines.join('\n') +
    (truncated
      ? `\n(Showing ${sample.length} of ${data.length} rows — raise GOOGLE_SHEETS_MAX_ROWS or leave blank for all.)`
      : '')
  );
}

/**
 * Formats the lead pipeline as a compact text block for the LLM prompt.
 * @deprecated for daily report — prefer formatSheetFixedColumns; kept for tooling.
 */
function formatSheetForPrompt(leads, maxRows = 2000) {
  if (!leads.length) return '(No data found in the sheet.)';

  const unlimited =
    !Number.isFinite(maxRows) || maxRows <= 0 || maxRows >= leads.length;
  const headers   = sortHeadersForPrompt(Object.keys(leads[0]));
  const sample    = unlimited ? leads : leads.slice(0, maxRows);
  const truncated = !unlimited && leads.length > maxRows;

  const lines = [
    'COLUMN MAP (use for matching — includes uniquely named blank columns): ' + headers.join(' | '),
    '',
  ];

  for (let i = 0; i < sample.length; i++) {
    const lead = sample[i];
    const parts = headers
      .map((h) => {
        const v = lead[h];
        return v ? `${h}: ${v}` : null;
      })
      .filter(Boolean);
    lines.push(`[sheet row ${i + 2}] ${parts.join(' | ')}`);
  }

  return lines.join('\n') +
    (truncated
      ? `\n(Showing ${maxRows} of ${leads.length} total rows — raise GOOGLE_SHEETS_MAX_ROWS or leave it blank for all.)`
      : '');
}

/**
 * Row cap for the LLM block: blank / unset env → all rows. Invalid → all rows.
 */
function maxRowsFromEnv() {
  const raw = (process.env.GOOGLE_SHEETS_MAX_ROWS ?? '').trim();
  if (raw === '') return Infinity;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
}

/**
 * Convenience wrapper: fetch → parse → format in one call.
 * - Empty GOOGLE_SHEETS_RANGE → entire **first** worksheet.
 * - Empty GOOGLE_SHEETS_MAX_ROWS → include **every** data row (watch token size).
 *
 * @param {{ callData?: Array<{ phone?: string, contact?: string }>, slackText?: string }} [reconcile]
 *        When provided, appends code-verified phone/name ↔ sheet row lines for the LLM.
 */
async function getLeadPipelineText(spreadsheetId, rangeInput, maxRowsOverride, reconcile = {}) {
  const cap =
    maxRowsOverride !== undefined && maxRowsOverride !== null
      ? maxRowsOverride
      : maxRowsFromEnv();
  const rows = await fetchSheetData(spreadsheetId, rangeInput ?? '');
  const leads = rowsToObjects(rows);
  const dataRowCount = Math.max(
    0,
    rows.slice(1).filter((row) => row.some((c) => String(c ?? '').trim() !== '')).length
  );

  let text = formatSheetFixedColumns(rows, cap);
  const { callData, slackText } = reconcile;
  if (callData !== undefined || slackText !== undefined) {
    text += '\n\n' + buildAutomatedSheetMatches(callData || [], slackText || '', rows);
  }

  return {
    leads,
    text,
    totalRows: dataRowCount,
  };
}

module.exports = {
  fetchSheetData,
  rowsToObjects,
  formatSheetForPrompt,
  formatSheetFixedColumns,
  getLeadPipelineText,
  uniqueHeaders,
  resolveValuesRange,
  columnLettersToIndex,
  sheetMatchColumnsFromEnv,
};
