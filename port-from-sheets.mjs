// Port existing BracketLab data from the old Google Sheet (CSV exports) into Supabase.
//
// Usage:
//   node port-from-sheets.mjs --dry-run     # parse + report, write nothing
//   node port-from-sheets.mjs               # actually import into Supabase
//
// Reads the Supabase URL + anon key from index.html so there's one source of truth.
// Idempotent: uses ON CONFLICT DO NOTHING, so re-running won't duplicate rows.
//
// Re-export fresh CSVs from your sheet (File > Download > CSV per tab) and drop them
// next to this script if you want the latest data. Expected files:
//   "BracketLab - Sets.csv"   (code, question, entries_json, created_at, created_by)
//   "BracketLab - Picks.csv"  (code, pick_id, bracket_json, ranking_json, score_json, created_at)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');
const SETS_CSV = join(DIR, 'BracketLab - Sets.csv');
const PICKS_CSV = join(DIR, 'BracketLab - Picks.csv');

// ---------- Supabase credentials (read from index.html) ----------
function readCreds() {
  const html = readFileSync(join(DIR, 'index.html'), 'utf8');
  const url = /const\s+SUPABASE_URL\s*=\s*'([^']+)'/.exec(html)?.[1];
  const key = /const\s+SUPABASE_ANON_KEY\s*=\s*'([^']+)'/.exec(html)?.[1];
  if (!url || !key || url.includes('YOUR_PROJECT')) {
    throw new Error('Could not read SUPABASE_URL / SUPABASE_ANON_KEY from index.html');
  }
  return { url, key };
}

// ---------- RFC-4180 CSV parser (handles quoted fields w/ commas, quotes, newlines) ----------
function parseCSV(str) {
  const rows = [];
  let field = '', row = [], inQuotes = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (inQuotes) {
      if (c === '"') {
        if (str[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* ignore */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Parse a CSV file into an array of objects keyed by header name.
function readCsvObjects(path) {
  const rows = parseCSV(readFileSync(path, 'utf8'));
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim());
  return rows.slice(1)
    .filter(r => r.some(v => v !== '')) // skip blank lines
    .map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

// ---------- helpers ----------
function jsonOrNull(s, fallback) {
  if (s == null || s === '') return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

// "11/12/2025 9:09:37" (M/D/YYYY H:MM:SS) -> ISO "2025-11-12T09:09:37Z". Returns null if unparseable.
function sheetDateToISO(s) {
  if (!s) return null;
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*$/.exec(s);
  if (!m) return null;
  const [, mo, d, y, h, mi, se] = m;
  const p = (n) => String(n).padStart(2, '0');
  return `${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:${p(se)}Z`;
}

// entries_json is an array of strings (or already {name,img}); normalize to [{name,img}].
function normalizeEntries(raw) {
  const arr = jsonOrNull(raw, []);
  if (!Array.isArray(arr)) return [];
  return arr.map(e => {
    if (typeof e === 'string') return { name: e, img: null };
    if (e && typeof e.name === 'string') return { name: e.name, img: e.img ?? null };
    return null;
  }).filter(Boolean);
}

// ---------- Supabase REST insert (ignore duplicates) ----------
async function insertRows(creds, table, onConflict, rows) {
  if (!rows.length) return { inserted: 0 };
  if (DRY_RUN) return { inserted: rows.length, dryRun: true };
  const res = await fetch(`${creds.url}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: {
      'apikey': creds.key,
      'Authorization': `Bearer ${creds.key}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=ignore-duplicates,return=representation',
    },
    body: JSON.stringify(rows),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${table} insert failed (${res.status}): ${text}`);
  let returned = [];
  try { returned = JSON.parse(text); } catch {}
  // With ignore-duplicates, return=representation returns only the rows actually inserted.
  return { inserted: Array.isArray(returned) ? returned.length : rows.length };
}

// ---------- main ----------
async function main() {
  const creds = readCreds();
  console.log(`Supabase: ${creds.url}`);
  console.log(DRY_RUN ? '(dry run — no writes)\n' : '(live import)\n');

  // SETS
  const setObjs = readCsvObjects(SETS_CSV);
  const setRows = setObjs.map(o => ({
    code: (o.code || '').trim().toUpperCase(),
    question: o.question || '',
    entries: normalizeEntries(o.entries_json),
    created_at: sheetDateToISO(o.created_at), // null -> DB default now()
    created_by: o.created_by || '',
  })).filter(r => r.code && r.entries.length >= 2);
  // drop null created_at so the column default applies
  setRows.forEach(r => { if (r.created_at == null) delete r.created_at; });

  const validCodes = new Set(setRows.map(r => r.code));
  console.log(`Sets parsed: ${setObjs.length}, importable: ${setRows.length}`);
  setRows.forEach(r => console.log(`  ${r.code}  "${r.question}"  (${r.entries.length} entries)`));

  // PICKS
  const pickObjs = readCsvObjects(PICKS_CSV);
  const pickRows = [];
  let orphans = 0;
  for (const o of pickObjs) {
    const code = (o.code || '').trim().toUpperCase();
    if (!validCodes.has(code)) { orphans++; continue; } // FK would fail
    const pickId = (o.pick_id || '').trim();
    const row = {
      code,
      // old sheet had no player_id; synthesize a stable, unique one from pick_id
      player_id: pickId ? `import_${pickId}` : `import_${code}_${pickRows.length}`,
      bracket: jsonOrNull(o.bracket_json, null),
      ranking: jsonOrNull(o.ranking_json, []),
      score: jsonOrNull(o.score_json, {}),
      created_at: sheetDateToISO(o.created_at),
    };
    if (pickId) row.pick_id = pickId; // preserve original UUID as primary key
    if (row.created_at == null) delete row.created_at;
    pickRows.push(row);
  }
  console.log(`\nPicks parsed: ${pickObjs.length}, importable: ${pickRows.length}` +
    (orphans ? `, skipped ${orphans} orphan(s) with no matching set` : ''));

  // INSERT (sets first for the FK)
  console.log('');
  const s = await insertRows(creds, 'sets', 'code', setRows);
  console.log(`Sets: ${s.inserted} inserted${s.dryRun ? ' (dry run)' : ' (new; duplicates skipped)'}`);
  const p = await insertRows(creds, 'picks', 'code,player_id', pickRows);
  console.log(`Picks: ${p.inserted} inserted${p.dryRun ? ' (dry run)' : ' (new; duplicates skipped)'}`);

  console.log('\nDone.');
}

main().catch(e => { console.error('\nERROR:', e.message); process.exit(1); });
