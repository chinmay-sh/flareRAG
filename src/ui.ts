/**
 * Minimal search tester served at `/`. The page itself is public; searches call
 * `/search` with the bearer token the user enters (kept in localStorage).
 */
export function renderWebInterface(collectionName = "Document search"): string {
  const name = escapeHtml(collectionName);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${name}</title>
<style>
  :root { --bg:#f7f7f8; --card:#fff; --border:#e2e2e6; --text:#1b1b1f; --muted:#6b6b76; --accent:#4f46e5; --good:#047857; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0f1115; --card:#171a21; --border:#2a2e38; --text:#e8e8ec; --muted:#9a9aa6; --accent:#818cf8; --good:#34d399; }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.55 system-ui, sans-serif; padding:32px 16px; }
  main { max-width:820px; margin:0 auto; }
  h1 { font-size:1.5rem; margin:0 0 4px; }
  p.sub { color:var(--muted); margin:0 0 20px; }
  .row { display:flex; gap:8px; margin-bottom:12px; flex-wrap:wrap; }
  input { flex:1; min-width:0; padding:10px 12px; border:1px solid var(--border); border-radius:8px; background:var(--card); color:var(--text); font:inherit; }
  button { padding:10px 16px; border:0; border-radius:8px; background:var(--accent); color:#fff; font:inherit; cursor:pointer; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:14px 16px; margin-top:12px; }
  .meta { display:flex; justify-content:space-between; gap:12px; color:var(--muted); font-size:.85rem; margin-bottom:6px; }
  .title { font-weight:600; color:var(--text); }
  .score { font-family:ui-monospace, monospace; color:var(--good); white-space:nowrap; }
  pre { white-space:pre-wrap; word-break:break-word; margin:0; font:inherit; }
  .warn { color:#b45309; }
</style>
</head>
<body>
<main>
  <h1>${name}</h1>
  <p class="sub">Embeddings → Pinecone → rerank. MCP endpoint: <code>/mcp</code> (Bearer token required).</p>
  <div class="row"><input id="token" type="password" placeholder="MCP token" autocomplete="off"></div>
  <div class="row">
    <input id="q" placeholder="Ask a question…">
    <button id="go">Search</button>
  </div>
  <div id="status" class="sub"></div>
  <div id="results"></div>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  try { $('token').value = localStorage.getItem('docs-search-token') || ''; } catch {}
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

  async function search() {
    const q = $('q').value.trim();
    const token = $('token').value.trim();
    if (!q) return;
    try { localStorage.setItem('docs-search-token', token); } catch {}
    $('status').textContent = 'Searching…';
    $('results').innerHTML = '';
    try {
      const res = await fetch('/search?q=' + encodeURIComponent(q), { headers: { Authorization: 'Bearer ' + token } });
      const data = await res.json();
      if (!res.ok) { $('status').textContent = 'Error: ' + (data.error || res.status); return; }
      $('status').innerHTML = data.results.length + ' results from ' + data.retrieved_count + ' candidates in ' + data.latency_ms + ' ms' +
        (data.rerank_warning ? ' <span class="warn">(' + esc(data.rerank_warning) + ')</span>' : '');
      $('results').innerHTML = data.results.map((r) =>
        '<div class="card"><div class="meta"><span><span class="title">' + esc(r.title) + '</span>' +
        (r.section ? ' · ' + esc(r.section) : '') + '<br>' + esc(r.source) + '</span>' +
        '<span class="score">' + (r.rerank_score !== null ? 'rerank ' + r.rerank_score.toFixed(3) + '<br>' : '') +
        'vector ' + r.retrieval_score.toFixed(3) + '</span></div><pre>' + esc(r.text) + '</pre></div>').join('');
    } catch (err) {
      $('status').textContent = 'Request failed: ' + err.message;
    }
  }
  $('go').addEventListener('click', search);
  $('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
