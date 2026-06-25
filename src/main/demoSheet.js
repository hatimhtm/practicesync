'use strict';

const http = require('http');

/**
 * The "Test drive" destination, bundled inside the app: a small spreadsheet-style
 * page that the live demo types rows into. Served on an ephemeral localhost port
 * so the controlled Chrome can load it like any real site — no files on disk, no
 * internet. (The source side is whatever real page the user pastes/picks.)
 */

const SHEET_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>DataDesk — Spreadsheet</title>
<style>
  :root { --green:#107c41; --ink:#1b2430; --muted:#667; --line:#e2e6ec; --bg:#f3f5f7; }
  * { box-sizing:border-box; }
  body { margin:0; font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; color:var(--ink); background:var(--bg); }
  header { background:var(--green); color:#fff; padding:12px 26px; display:flex; align-items:center; gap:11px; box-shadow:0 2px 10px rgba(0,0,0,.12); }
  header .logo { width:28px; height:28px; border-radius:7px; background:#fff; display:grid; place-items:center; color:var(--green); font-weight:800; }
  header h1 { font-size:17px; margin:0; font-weight:700; }
  header .tag { margin-left:auto; opacity:.85; font-size:13px; }
  main { max-width:860px; margin:26px auto; padding:0 22px; }
  .panel { background:#fff; border:1px solid var(--line); border-radius:12px; padding:20px 22px; box-shadow:0 1px 3px rgba(20,30,50,.05); }
  .entry { display:grid; grid-template-columns:1fr 1fr auto; gap:12px; align-items:end; }
  label.lbl { display:block; font-size:12px; text-transform:uppercase; letter-spacing:.5px; color:var(--muted); margin-bottom:6px; font-weight:600; }
  input { width:100%; font-size:15px; padding:11px 13px; border:2px solid var(--line); border-radius:8px; outline:none; }
  input:focus { border-color:var(--green); }
  .btn { font:inherit; font-weight:600; border:0; border-radius:8px; padding:12px 18px; cursor:pointer; background:var(--green); color:#fff; white-space:nowrap; }
  table { width:100%; border-collapse:collapse; margin-top:20px; }
  th { text-align:left; font-size:12px; text-transform:uppercase; letter-spacing:.5px; color:var(--muted); padding:8px 12px; border-bottom:2px solid var(--line); }
  td { padding:11px 12px; border-bottom:1px solid var(--line); }
  td.idx { color:var(--muted); width:40px; }
  tr.row { animation:pop .25s ease; }
  @keyframes pop { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }
  h2 { font-size:17px; margin:0 0 4px; }
  .sub { color:var(--muted); font-size:13px; margin-bottom:14px; }
  .count { color:var(--muted); font-size:13px; }
  .empty { color:var(--muted); padding:16px 0; }
</style></head>
<body>
<header><div class="logo">D</div><h1>DataDesk</h1><span class="tag">Spreadsheet</span></header>
<main><div class="panel">
  <h2>Add a row</h2>
  <div class="sub">Each entry is copied in from the source page and added to the sheet below.</div>
  <div class="entry">
    <div><label class="lbl" id="labelA">Column A</label><input id="cellA" placeholder="…" autocomplete="off" /></div>
    <div><label class="lbl" id="labelB">Column B</label><input id="cellB" placeholder="…" autocomplete="off" /></div>
    <button id="addRow" class="btn">Add row</button>
  </div>
  <table><thead><tr><th class="idx">#</th><th id="headA">Column A</th><th id="headB">Column B</th></tr></thead>
  <tbody id="sheet"><tr><td colspan="3" class="empty">No rows yet.</td></tr></tbody></table>
  <p class="count" id="count"></p>
</div></main>
<script>
  var $ = function (id) { return document.getElementById(id); };
  var p = new URLSearchParams(location.search);
  if (p.get('a')) { $('labelA').textContent = $('headA').textContent = p.get('a'); }
  if (p.get('b')) { $('labelB').textContent = $('headB').textContent = p.get('b'); }
  $('addRow').addEventListener('click', function () {
    var a = $('cellA').value.trim(), b = $('cellB').value.trim();
    if (!a && !b) return;
    var body = $('sheet'); if (body.querySelector('.empty')) body.innerHTML = '';
    var n = body.querySelectorAll('tr.row').length + 1;
    var tr = document.createElement('tr'); tr.className = 'row';
    tr.innerHTML = '<td class="idx">' + n + '</td><td>' + esc(a) + '</td><td>' + esc(b) + '</td>';
    body.appendChild(tr);
    $('count').textContent = n + ' row' + (n === 1 ? '' : 's') + ' added';
    $('cellA').value = ''; $('cellB').value = ''; $('cellA').focus();
  });
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return ({ '&':'&amp;','<':'&lt;','>':'&gt;' })[c]; }); }
</script>
</body></html>`;

/** Start a localhost server that serves the sheet. Returns { url, close }. */
function startSheetServer() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(SHEET_HTML);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

module.exports = { SHEET_HTML, startSheetServer };
