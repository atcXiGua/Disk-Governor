const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const ROOT = __dirname;
const CORE = path.join(ROOT, 'core.ps1');
const UI = path.join(ROOT, 'ui.html');
const HISTORY = path.join(ROOT, 'history.json');
const PORT_BASE = 7788;

function runPS(args, timeout = 240000) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CORE, ...args],
      { maxBuffer: 64 * 1024 * 1024, timeout, windowsHide: true, encoding: 'buffer' },
      (err, stdout) => {
        if (err && !stdout) return reject(err);
        const text = stdout.toString('utf8').replace(/^\uFEFF/, '').trim();
        try {
          resolve(JSON.parse(text));
        } catch (e) {
          reject(new Error('PowerShell 返回内容无法解析: ' + text.slice(0, 300)));
        }
      });
  });
}

function readHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY, 'utf8')); } catch { return []; }
}
function appendHistory(entry) {
  const list = readHistory();
  list.unshift(entry);
  try { fs.writeFileSync(HISTORY, JSON.stringify(list.slice(0, 50), null, 2), 'utf8'); } catch {}
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function body(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
  });
}

function openPath(p) {
  if (!p) return;
  spawn('explorer.exe', [p], { detached: true, windowsHide: true }).unref();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  try {
    if (p === '/' || p === '/index.html') {
      const html = fs.readFileSync(UI);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length });
      return res.end(html);
    }

    if (p === '/api/scan' && req.method === 'GET') {
      const data = await runPS(['-Mode', 'scan']);
      return json(res, 200, data);
    }

    if (p === '/api/clean' && req.method === 'POST') {
      const b = await body(req);
      const ids = Array.isArray(b.ids) ? b.ids.filter(x => /^[a-z]+$/.test(x)) : [];
      if (!ids.length) return json(res, 400, { ok: false, error: '未选择清理项' });
      const data = await runPS(['-Mode', 'clean', '-Ids', ids.join(',')], 600000);
      if (data.ok) appendHistory({
        when: data.when, freed: data.freed, bytes: data.bytes,
        moved: data.moved, skipped: data.skipped, ids: data.ids, backup: data.backup
      });
      return json(res, 200, data);
    }

    if (p === '/api/history' && req.method === 'GET') {
      return json(res, 200, { ok: true, list: readHistory() });
    }

    if (p === '/api/open' && req.method === 'POST') {
      const b = await body(req);
      openPath(typeof b.path === 'string' ? b.path : '');
      return json(res, 200, { ok: true });
    }

    if (p === '/api/ping') return json(res, 200, { ok: true });

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (e) {
    json(res, 500, { ok: false, error: String(e && e.message || e) });
  }
});

function listen(port, attempt = 0) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && attempt < 8) return listen(port + 1, attempt + 1);
    console.error('启动失败:', e.message);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    console.log('');
    console.log('  C盘助手 已启动');
    console.log('  ' + url);
    console.log('');
    console.log('  关闭此窗口即退出工具');
    console.log('');
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, windowsHide: true }).unref();
  });
}

listen(PORT_BASE);
