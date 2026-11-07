// Piano Trainer helper server (personal use).
// - Serves the web app (public/)
// - Keeps a song library (songs/*.mid)
// - Downloads audio from YouTube with yt-dlp so the browser can transcribe it to MIDI
// - Serves HTTPS on your local network so tablets can use the microphone / MIDI
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const SONGS = path.join(ROOT, 'songs');
const TMP = path.join(ROOT, 'tmp');
const CERT = path.join(ROOT, 'cert');
const HTTP_PORT = Number(process.env.PORT || 8000);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8443);
for (const d of [SONGS, TMP, CERT]) fs.mkdirSync(d, { recursive: true });

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.bin': 'application/octet-stream',
  '.mid': 'audio/midi', '.midi': 'audio/midi', '.m4a': 'audio/mp4', '.webm': 'audio/webm',
  '.mp3': 'audio/mpeg', '.opus': 'audio/ogg', '.ogg': 'audio/ogg', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};

function findYtDlp() {
  const local = path.join(ROOT, 'tools', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  if (fs.existsSync(local)) return local;
  const winget = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'yt-dlp.exe');
  if (process.platform === 'win32' && fs.existsSync(winget)) return winget;
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['yt-dlp'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0];
  return null;
}

function safeName(name) {
  const base = path.basename(String(name || '')).replace(/[^\w\-. ()']/g, '_').slice(0, 120);
  return base.replace(/\.(mid|midi)$/i, '') + '.mid';
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function sendFile(res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size, 'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function isYouTubeUrl(u) {
  try {
    const url = new URL(u);
    return ['http:', 'https:'].includes(url.protocol) &&
      /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i.test(url.hostname);
  } catch { return false; }
}

// Clean temp audio older than 1 hour
setInterval(() => {
  for (const f of fs.readdirSync(TMP)) {
    const p = path.join(TMP, f);
    try { if (Date.now() - fs.statSync(p).mtimeMs > 3600e3) fs.unlinkSync(p); } catch {}
  }
}, 600e3).unref();

async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  try {
    if (p === '/api/status') {
      return sendJson(res, 200, { server: true, ytdlp: !!findYtDlp() });
    }
    if (p === '/api/songs' && req.method === 'GET') {
      const list = fs.readdirSync(SONGS).filter(f => /\.midi?$/i.test(f)).map(f => {
        const st = fs.statSync(path.join(SONGS, f));
        return { name: f, size: st.size, added: st.mtimeMs };
      }).sort((a, b) => b.added - a.added);
      return sendJson(res, 200, list);
    }
    if (p === '/api/songs' && req.method === 'POST') {
      const name = safeName(url.searchParams.get('name') || 'song');
      const body = await readBody(req);
      if (body.slice(0, 4).toString('latin1') !== 'MThd') return sendJson(res, 400, { error: 'Not a MIDI file' });
      fs.writeFileSync(path.join(SONGS, name), body);
      return sendJson(res, 200, { name });
    }
    if (p.startsWith('/api/songs/') && req.method === 'DELETE') {
      const f = path.join(SONGS, path.basename(p.slice('/api/songs/'.length)));
      if (fs.existsSync(f)) fs.unlinkSync(f);
      return sendJson(res, 200, { ok: true });
    }
    if (p.startsWith('/songs/')) return sendFile(res, path.join(SONGS, path.basename(p.slice(7))));
    if (p.startsWith('/tmp/')) return sendFile(res, path.join(TMP, path.basename(p.slice(5))));

    if (p === '/api/youtube') {
      const target = url.searchParams.get('url') || '';
      if (!isYouTubeUrl(target)) return sendJson(res, 400, { error: 'Please paste a YouTube link.' });
      const ytdlp = findYtDlp();
      if (!ytdlp) return sendJson(res, 500, { error: 'yt-dlp is not installed on the computer running the server. See README.' });
      const id = Date.now().toString(36);
      const args = ['--no-playlist', '-f', 'bestaudio[ext=m4a]/bestaudio', '--max-filesize', '200M',
        '-o', path.join(TMP, `${id}.%(ext)s`), '--print', 'after_move:%(title)s|||%(filepath)s', '--no-simulate', target];
      const proc = spawn(ytdlp, args, { windowsHide: true });
      let out = '', err = '';
      proc.stdout.on('data', d => out += d);
      proc.stderr.on('data', d => err += d);
      proc.on('close', code => {
        const line = out.trim().split(/\r?\n/).filter(l => l.includes('|||')).pop();
        if (code !== 0 || !line) return sendJson(res, 500, { error: 'Download failed: ' + (err.trim().split('\n').pop() || 'unknown error') });
        const [title, fp] = line.split('|||');
        sendJson(res, 200, { title, audio: '/tmp/' + path.basename(fp) });
      });
      return;
    }

    // static
    let file = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : p));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    return sendFile(res, file);
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: String(e.message || e) });
  }
}

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
}

async function getCert() {
  const keyF = path.join(CERT, 'key.pem'), certF = path.join(CERT, 'cert.pem');
  if (fs.existsSync(keyF) && fs.existsSync(certF)) return { key: fs.readFileSync(keyF), cert: fs.readFileSync(certF) };
  const selfsigned = require('selfsigned');
  const ips = lanAddresses();
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'piano-trainer.local' }], {
    keySize: 2048, algorithm: 'sha256',
    notAfterDate: new Date(Date.now() + 5 * 365 * 864e5),
    extensions: [{ name: 'subjectAltName', altNames: [
      { type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, ...ips.map(ip => ({ type: 7, ip })),
    ] }],
  });
  fs.writeFileSync(keyF, pems.private); fs.writeFileSync(certF, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

(async () => {
  http.createServer(handler).listen(HTTP_PORT, '0.0.0.0');
  try {
    https.createServer(await getCert(), handler).listen(HTTPS_PORT, '0.0.0.0');
  } catch (e) { console.warn('HTTPS disabled:', e.message); }
  console.log('\n  Piano Trainer is running.\n');
  console.log(`  On this computer:   http://localhost:${HTTP_PORT}`);
  for (const ip of lanAddresses()) console.log(`  On a tablet/laptop: https://${ip}:${HTTPS_PORT}   (accept the certificate warning once)`);
  console.log(`\n  YouTube import: ${findYtDlp() ? 'ready' : 'needs yt-dlp  ->  winget install yt-dlp.yt-dlp'}`);
  console.log('  Press Ctrl+C to stop.\n');
})();
