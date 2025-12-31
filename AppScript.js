// ====== CONFIG ======
const SPREADSHEET_ID = 'PUT_YOUR_SHEET_ID_HERE'; // leave as-is if bound script
const SHEET_SETS = 'Sets';
const SHEET_PICKS = 'Picks';
const SHEET_STATS = 'Stats'; // optional


function sheetBy(name){
if (SPREADSHEET_ID && SPREADSHEET_ID !== 'PUT_YOUR_SHEET_ID_HERE') {
return SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(name);
}
return SpreadsheetApp.getActive().getSheetByName(name);
}


function json(data) {
return ContentService.createTextOutput(JSON.stringify(data))
.setMimeType(ContentService.MimeType.JSON);
}


function parseBody(e) {
try { if (e.postData && e.postData.contents) return JSON.parse(e.postData.contents); } catch(_) {}
try { if (e.parameter && e.parameter.payload) return JSON.parse(e.parameter.payload); } catch(_) {}
return {};
}


function doOptions(e){ return json({ok:true}); }


function doGet(e){
const action = (e.parameter.action || 'ping').toLowerCase();
if (action === 'ping') return json({ok:true});


if (action === 'fetch_set') {
const code = (e.parameter.code || '').toUpperCase();
const sets = sheetBy(SHEET_SETS).getDataRange().getValues();
const head = sets[0];
const rows = sets.slice(1);
const iCode = head.indexOf('code');
const iQ = head.indexOf('question');
const iE = head.indexOf('entries_json');
const row = rows.find(r => String(r[iCode]).toUpperCase() === code);
if (!row) return json({ok:false, error:'NOT_FOUND'});
return json({ok:true, code, question: row[iQ], entries: JSON.parse(row[iE])});
}


if (action === 'my_picks') {
const code = (e.parameter.code || '').toUpperCase();
const playerId = (e.parameter.player_id || '').trim();
if (!code || !playerId) return json({ok:true, found:false});

const picksS = sheetBy(SHEET_PICKS);
const vals = picksS.getDataRange().getValues();
const head = vals[0];
const iCode = head.indexOf('code');
const iPlayerId = head.indexOf('player_id');
const iBracket = head.indexOf('bracket_json');
const iRanking = head.indexOf('ranking_json');

// Find the user's pick for this bracket code
const row = vals.slice(1).find(r =>
  String(r[iCode]).toUpperCase() === code &&
  String(r[iPlayerId]).trim() === playerId
);

if (!row) return json({ok:true, found:false});

try {
  const bracket = JSON.parse(row[iBracket] || 'null');
  const ranking = JSON.parse(row[iRanking] || '[]');
  return json({ok:true, found:true, bracket, ranking});
} catch(err) {
  return json({ok:true, found:false, error:'PARSE_ERROR'});
}
}


if (action === 'stats') {
const code = (e.parameter.code || '').toUpperCase();
const picksS = sheetBy(SHEET_PICKS);
const vals = picksS.getDataRange().getValues();
const head = vals[0];
const rows = vals.slice(1).filter(r => String(r[head.indexOf('code')]).toUpperCase() === code);
if (!rows.length) return json({ok:true, code, total:0, aggregate:{}});


const idxScore = head.indexOf('score_json');
const idxRank = head.indexOf('ranking_json');


const aggScores = new Map();
const rankTallies = new Map(); // entry -> list of ranks


rows.forEach(r => {
const scoreObj = JSON.parse(r[idxScore] || '{}');
for (const [k,v] of Object.entries(scoreObj)) {
aggScores.set(k, (aggScores.get(k)||0) + Number(v||0));
}
const ranks = JSON.parse(r[idxRank] || '[]');
ranks.forEach((entry, i) => {
const arr = rankTallies.get(entry) || [];
arr.push(i+1); // 1-based rank
rankTallies.set(entry, arr);
});
});


const aggregate = Array.from(aggScores.entries()).map(([entry, totalScore]) => {
const ranks = rankTallies.get(entry) || [];
const avgRank = ranks.length ? (ranks.reduce((a,b)=>a+b,0)/ranks.length) : null;
return { entry, totalScore, avgRank, samples: ranks.length };
}).sort((a,b)=> (b.totalScore - a.totalScore) || ((a.avgRank||1e9) - (b.avgRank||1e9)) );


return json({ok:true, code, total: rows.length, aggregate});
}


if (action === 'browse') {
// Return recent sets for discovery
const setsS = sheetBy(SHEET_SETS);
const vals = setsS.getDataRange().getValues();
const head = vals[0];
const rows = vals.slice(1).slice(-50).reverse();
const out = rows.map(r => ({
code: r[head.indexOf('code')],
question: r[head.indexOf('question')],
entries: JSON.parse(r[head.indexOf('entries_json')]||'[]'),
created_at: r[head.indexOf('created_at')]
}));
return json({ok:true, rows: out});
}


return json({ok:false, error:'BAD_ACTION'});
}


function doPost(e){
const body = parseBody(e);
const action = String(body.action||'').toLowerCase();


if (action === 'create_set') {
const question = String(body.question||'').trim().slice(0, 200);
let entries = Array.isArray(body.entries) ? body.entries.map(x=>String(x).trim()).filter(Boolean) : [];
entries = Array.from(new Set(entries)); // dedupe
if (entries.length < 2) return json({ok:false, error:'NEED_AT_LEAST_2'});


const code = genCode();
sheetBy(SHEET_SETS).appendRow([code, question, JSON.stringify(entries), new Date(), String(body.created_by||'')]);
return json({ok:true, code});
}


if (action === 'submit_picks') {
const code = String(body.code||'').toUpperCase();
const playerId = String(body.player_id||'').trim();
const bracket = body.bracket || null; // object
const ranking = body.ranking || []; // array of entries winner→last
const scoreMap = body.scores || {}; // entry→score
if (!code || !ranking.length) return json({ok:false, error:'BAD_PAYLOAD'});


const pickId = Utilities.getUuid();
// Schema: code, pick_id, player_id, bracket_json, ranking_json, score_json, created_at
sheetBy(SHEET_PICKS).appendRow([code, pickId, playerId, JSON.stringify(bracket), JSON.stringify(ranking), JSON.stringify(scoreMap), new Date()]);
return json({ok:true, pick_id: pickId});
}


return json({ok:false, error:'BAD_ACTION'});
}


function genCode(){
// 5-char base36 from time & random
const n = Date.now() + Math.floor(Math.random()*1e6);
return n.toString(36).toUpperCase().slice(-5);
}