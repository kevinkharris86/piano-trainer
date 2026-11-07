(() => {
'use strict';
const $ = s => document.querySelector(s);
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const isBlack = m => [1, 3, 6, 8, 10].includes(m % 12);
const noteName = m => NAMES[m % 12] + (Math.floor(m / 12) - 1);
const midiFreq = m => 440 * Math.pow(2, (m - 69) / 12);
const store = {
  get(k, d) { try { const v = localStorage.getItem('pt.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('pt.' + k, JSON.stringify(v)); } catch {} },
};

// ---------------------------------------------------------------- state
const S = {
  song: null, t: 0, prevT: 0, playing: false,
  mode: store.get('mode', 'follow'), hand: store.get('hand', 'both'), speed: store.get('speed', 1),
  chords: [], chordIdx: 0, armed: false, hits: new Set(), pressed: new Map(),
  wrong: 0, startedAt: 0, lo: 48, hi: 72, input: store.get('input', null), server: null, playPtr: 0,
  opts: {
    names: store.get('names', true), fit: store.get('fit', true), sound: store.get('sound', false),
    other: store.get('other', true), strict: store.get('strict', true), zoom: store.get('zoom', 180), split: store.get('split', 60),
  },
};
const listener = new MicListener();
listener.setSensitivity(store.get('sens', 55) / 100);

// ---------------------------------------------------------------- sound
let actx = null;
function audio() {
  if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
  if (actx.state === 'suspended') actx.resume();
  return actx;
}
function playTone(m, dur = 0.6, vel = 0.7) {
  const a = audio(), t0 = a.currentTime, f = midiFreq(m);
  const g = a.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(0.16 * vel, t0 + 0.006);
  const end = t0 + Math.min(3, 0.5 + dur * 1.4);
  g.gain.exponentialRampToValueAtTime(0.0008, end);
  const lp = a.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = Math.min(9000, f * 7);
  for (const [h, type, amp] of [[1, 'triangle', 1], [2, 'sine', 0.35], [3, 'sine', 0.12]]) {
    const o = a.createOscillator(), og = a.createGain();
    o.type = type; o.frequency.value = f * h; og.gain.value = amp;
    o.connect(og).connect(lp); o.start(t0); o.stop(end + 0.05);
  }
  lp.connect(g).connect(a.destination);
}
const soundAllowed = () => S.input !== 'mic';

// ---------------------------------------------------------------- songs
function demoSong(name, parts, bpm) {
  const spb = 60 / bpm, notes = [];
  for (const [hand, list] of parts) {
    let beat = 0;
    for (const [p, d] of list) {
      for (const m of [].concat(p)) if (m) notes.push({ midi: m, start: 1 + beat * spb, dur: d * spb * 0.95, vel: 0.7, hand, track: hand === 'right' ? 0 : 1 });
      beat += d;
    }
  }
  return makeSong(name, notes, 2);
}
const DEMOS = [
  () => demoSong('Warm-up: C major scale', [['right',
    [60, 62, 64, 65, 67, 69, 71, 72, 71, 69, 67, 65, 64, 62, 60].map((m, i, a) => [m, i === a.length - 1 ? 2 : 1])]], 80),
  () => demoSong('Warm-up: chords C · F · G · C', [
    ['right', [[[60, 64, 67], 2], [[60, 65, 69], 2], [[59, 62, 67], 2], [[60, 64, 67], 2], [[60, 64, 67], 2], [[60, 65, 69], 2], [[59, 62, 67], 2], [[60, 64, 67], 4]]],
    ['left', [[48, 2], [41, 2], [43, 2], [48, 2], [48, 2], [41, 2], [43, 2], [36, 4]]]], 60),
  () => demoSong('Twinkle Twinkle Little Star (traditional)', [['right',
    [60, 60, 67, 67, 69, 69, [67, 2], 65, 65, 64, 64, 62, 62, [60, 2], 67, 67, 65, 65, 64, 64, [62, 2], 67, 67, 65, 65, 64, 64, [62, 2],
     60, 60, 67, 67, 69, 69, [67, 2], 65, 65, 64, 64, 62, 62, [60, 2]].map(x => Array.isArray(x) ? x : [x, 1])]], 90),
  () => {
    const C = [48, 52, 55], G = [43, 47, 50];
    return demoSong('Ode to Joy (Beethoven, public domain)', [
      ['right', [[64, 1], [64, 1], [65, 1], [67, 1], [67, 1], [65, 1], [64, 1], [62, 1], [60, 1], [60, 1], [62, 1], [64, 1], [64, 1.5], [62, .5], [62, 2],
                 [64, 1], [64, 1], [65, 1], [67, 1], [67, 1], [65, 1], [64, 1], [62, 1], [60, 1], [60, 1], [62, 1], [64, 1], [62, 1.5], [60, .5], [60, 2]]],
      ['left', [[C, 4], [G, 4], [C, 4], [G, 4], [C, 4], [G, 4], [C, 4], [G, 2], [C, 2]]]], 92);
  },
];

function makeSong(name, notes, trackCount) {
  notes.sort((a, b) => a.start - b.start || a.midi - b.midi);
  const song = { name, notes, trackCount, start: notes.length ? notes[0].start : 0, end: 0, min: 127, max: 0 };
  for (const n of notes) { song.end = Math.max(song.end, n.start + n.dur); song.min = Math.min(song.min, n.midi); song.max = Math.max(song.max, n.midi); }
  return song;
}

function songFromMidi(name, buf) {
  const midi = new PianoVendor.Midi(buf);
  const tracks = midi.tracks.filter(t => t.notes.length && t.channel !== 9);
  if (!tracks.length) throw new Error('This MIDI file has no piano notes.');
  const notes = [];
  tracks.forEach((t, ti) => t.notes.forEach(n => notes.push({
    midi: n.midi, start: n.time, dur: Math.max(0.06, n.duration), vel: n.velocity, track: ti, hand: null,
  })));
  const song = makeSong(name.replace(/\.(mid|midi)$/i, ''), notes, tracks.length);
  song.trackNames = tracks.map(t => (t.name || '').toLowerCase());
  song.trackAvg = tracks.map(t => t.notes.reduce((a, n) => a + n.midi, 0) / t.notes.length);
  assignHands(song);
  return song;
}

function assignHands(song) {
  if (!song.trackAvg) return; // demos already have hands
  const n = song.trackAvg.length;
  const hint = song.trackNames.map(nm => /\b(left|lh|bass|l\.?h\.?)\b/.test(nm) ? 'left' : /\b(right|rh|melody|treble|r\.?h\.?)\b/.test(nm) ? 'right' : null);
  let hi = 0, lo = 0;
  song.trackAvg.forEach((a, i) => { if (a > song.trackAvg[hi]) hi = i; if (a < song.trackAvg[lo]) lo = i; });
  for (const note of song.notes) {
    const i = note.track;
    if (n >= 2 && hint[i]) note.hand = hint[i];
    else if (n >= 2 && i === hi) note.hand = 'right';
    else if (n >= 2 && i === lo) note.hand = 'left';
    else note.hand = note.midi >= S.opts.split ? 'right' : 'left';
  }
}

// ---------------------------------------------------------------- practice engine
const required = n => S.hand === 'both' || n.hand === S.hand;

function buildChords() {
  S.chords = [];
  const notes = S.song.notes;
  for (let i = 0; i < notes.length; i++) {
    if (!required(notes[i])) continue;
    const last = S.chords[S.chords.length - 1];
    if (last && notes[i].start - last.t < 0.06) last.idx.push(i);
    else S.chords.push({ t: notes[i].start, idx: [i] });
  }
  for (const c of S.chords) { c.midis = [...new Set(c.idx.map(i => notes[i].midi))]; c.got = new Map(); }
}

function loadSong(song) {
  S.song = song;
  $('#songTitle').textContent = song.name;
  $('#empty').hidden = true;
  buildChords();
  computeRange();
  restart();
}

function restart() {
  if (!S.song) return;
  seek(S.song.start - 2.2);
  S.wrong = 0; S.startedAt = performance.now();
  S.playing = S.mode === 'follow';
  updatePlayBtn();
}

function seek(time) {
  S.t = S.prevT = time;
  S.chordIdx = S.chords.findIndex(c => c.t >= time - 0.001);
  if (S.chordIdx < 0) S.chordIdx = S.chords.length;
  for (let i = S.chordIdx; i < S.chords.length; i++) S.chords[i].got = new Map();
  for (const i of [...S.hits]) if (S.song.notes[i].start >= time - 0.001) S.hits.delete(i);
  S.playPtr = S.song.notes.findIndex(n => n.start > time);
  if (S.playPtr < 0) S.playPtr = S.song.notes.length;
  S.armed = false;
  arm();
}

const activeChord = () => S.chords[S.chordIdx];

function arm() {
  const c = activeChord();
  const shouldArm = c && S.mode !== 'listen' && (S.mode === 'follow' || S.t >= c.t - 0.35 * S.speed);
  if (shouldArm && !S.armed) { S.armed = true; listener.setExpected(c.midis.filter(m => !c.got.has(m))); }
  if (!shouldArm) { S.armed = false; listener.setExpected([]); }
}

function advance() {
  const c = activeChord();
  if (c) c.idx.forEach(i => S.hits.add(i));
  S.chordIdx++;
  S.armed = false;
  arm();
}

// Strict chords: all notes of a chord must be struck together (within CHORD_WINDOW ms)
// and, for keys you can release (MIDI / touch), still be held down.
const CHORD_WINDOW = { midi: 250, touch: 400, mic: 350 };
function pruneChord(c, now) {
  if (!S.opts.strict || !c) return;
  for (const [m, g] of c.got) {
    if (now - g.t > (CHORD_WINDOW[g.src] || 300) || (g.src !== 'mic' && !S.pressed.has(m))) {
      c.got.delete(m);
      if (g.src === 'mic') listener.rearm(m);
    }
  }
}
function handleInput(m, source) {
  if (S.mode === 'listen' || !S.song) return;
  if (S.mode === 'follow' && !S.playing && S.chordIdx < S.chords.length) { S.playing = true; updatePlayBtn(); }
  const c = activeChord(), now = performance.now();
  const ok = !!(c && S.armed && c.midis.includes(m));
  S.pressed.set(m, { ok, src: source, until: source === 'mic' ? now + 350 : Infinity });
  if (ok) {
    c.got.set(m, { t: now, src: source });
    pruneChord(c, now);
    if (c.got.size >= c.midis.length) advance();
  } else if (source !== 'mic') S.wrong++;
}
function handleRelease(m, source) {
  const p = S.pressed.get(m);
  if (p && p.src === source) S.pressed.delete(m);
  pruneChord(activeChord(), performance.now());
}
listener.onHeard = m => handleInput(m, 'mic');

function finish() {
  if (!S.playing) return;
  S.playing = false; updatePlayBtn();
  const secs = Math.round((performance.now() - S.startedAt) / 1000);
  const wrong = S.input === 'mic' || S.mode === 'listen' ? '' : ` · ${S.wrong} wrong note${S.wrong === 1 ? '' : 's'}`;
  toast(S.mode === 'listen' ? 'End of song' : `🎉 Song complete! ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}${wrong}`, 4000);
}

function tick(dt) {
  if (!S.song) return;
  S.prevT = S.t;
  const c = activeChord();
  if (S.playing) {
    if (S.mode === 'follow') {
      const target = c ? c.t : S.song.end + 0.5;
      const rem = target - S.t;
      if (rem > 0) S.t = Math.min(target, S.t + S.speed * Math.max(1, rem / 0.8) * dt);
      else if (!c) finish();
    } else if (S.mode === 'wait') {
      S.t += S.speed * dt;
      if (c && S.t > c.t) S.t = c.t;
      if (!c && S.t > S.song.end + 0.5) finish();
    } else {
      S.t += S.speed * dt;
      while (c && S.chordIdx < S.chords.length && S.chords[S.chordIdx].t <= S.t) { S.chords[S.chordIdx].idx.forEach(i => S.hits.add(i)); S.chordIdx++; }
      if (S.t > S.song.end + 0.5) finish();
    }
  }
  arm();
  // play / mark notes the player isn't responsible for
  const notes = S.song.notes;
  while (S.playPtr < notes.length && notes[S.playPtr].start <= S.t + 1e-6) {
    const n = notes[S.playPtr], i = S.playPtr++;
    if (n.start < S.prevT - 0.05) continue;
    if (S.mode === 'listen') { if (required(n) || S.opts.other) playTone(n.midi, n.dur, n.vel); S.hits.add(i); }
    else if (!required(n)) { S.hits.add(i); if (S.opts.other && soundAllowed()) playTone(n.midi, n.dur, n.vel * 0.8); }
  }
}

// ---------------------------------------------------------------- rendering
const cv = $('#cv'), g = cv.getContext('2d');
let W = 0, H = 0, keyRects = new Map(), kbH = 0, hitY = 0;

function computeRange() {
  let lo = 21, hi = 108;
  if (S.opts.fit && S.song && S.song.notes.length) {
    lo = S.song.min; hi = S.song.max;
    lo -= ((lo % 12) + 12) % 12;            // down to a C
    hi += 11 - (((hi % 12) + 12) % 12);     // up to a B
    while (hi - lo < 35) { lo -= 12; if (hi - lo < 35) hi += 12; }
    lo = Math.max(21, lo); hi = Math.min(108, hi);
  }
  S.lo = lo; S.hi = hi;
  layout();
}

function layout() {
  const dpr = window.devicePixelRatio || 1;
  const r = cv.getBoundingClientRect();
  W = r.width; H = r.height;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const whites = [];
  for (let m = S.lo; m <= S.hi; m++) if (!isBlack(m)) whites.push(m);
  const ww = W / whites.length;
  kbH = Math.max(80, Math.min(H * 0.26, ww * 6.2, 240));
  hitY = H - kbH;
  keyRects = new Map();
  whites.forEach((m, i) => keyRects.set(m, { x: i * ww, w: ww, black: false }));
  for (let m = S.lo; m <= S.hi; m++) if (isBlack(m) && keyRects.has(m - 1)) {
    const bw = ww * 0.6, wk = keyRects.get(m - 1);
    keyRects.set(m, { x: wk.x + ww - bw / 2, w: bw, black: true });
  }
}
window.addEventListener('resize', layout);

const COL = { right: [79, 140, 255], left: [255, 181, 71] };
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

function roundRect(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

function render(now) {
  g.fillStyle = '#0f1117'; g.fillRect(0, 0, W, H);
  // guide lines at every C and F
  for (const [m, k] of keyRects) if (!k.black && (m % 12 === 0 || m % 12 === 5)) {
    g.fillStyle = m % 12 === 0 ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.035)';
    g.fillRect(Math.round(k.x), 0, 1, hitY);
  }
  const c = activeChord();
  const waiting = S.song && S.armed && c && S.t >= c.t - 0.001 && S.mode !== 'listen';
  if (S.song) {
    const pps = S.opts.zoom;
    const notes = S.song.notes;
    const active = new Set(S.armed && c ? c.idx : []);
    const pulse = 0.5 + 0.5 * Math.sin(now / 180);
    // draw white-key notes first so black-key notes sit on top
    for (const pass of [false, true]) for (let i = 0; i < notes.length; i++) {
      const n = notes[i], k = keyRects.get(n.midi);
      if (!k || k.black !== pass) continue;
      const yb = hitY - (n.start - S.t) * pps, yt = yb - n.dur * pps;
      if (yb < 0 || yt > hitY) continue;
      const req = required(n), hit = S.hits.has(i);
      const col = COL[n.hand] || COL.right;
      const pad = k.black ? 1 : 2;
      const x = k.x + pad, w = k.w - pad * 2, y = Math.max(yt, -10), h = Math.min(yb, hitY) - y;
      if (h <= 0) continue;
      roundRect(x, y, w, h, 5);
      if (hit) g.fillStyle = req ? 'rgba(61,220,132,0.85)' : rgba(col, 0.25);
      else g.fillStyle = req ? rgba(k.black ? col.map(v => v * 0.75) : col, 1) : rgba(col, 0.28);
      g.fill();
      if (active.has(i) && !hit) { g.lineWidth = 2 + pulse * 2; g.strokeStyle = 'rgba(255,255,255,' + (0.6 + 0.4 * pulse) + ')'; g.stroke(); }
      if (S.opts.names && w > 13 && h > 16 && req) {
        g.fillStyle = 'rgba(0,0,0,0.65)'; g.font = `600 ${Math.min(14, w * 0.5)}px system-ui`;
        g.textAlign = 'center'; g.textBaseline = 'bottom';
        g.fillText(NAMES[n.midi % 12], x + w / 2, Math.min(yb, hitY) - 3);
      }
    }
    // "Play:" prompt
    if (waiting) {
      const parts = c.midis.slice().sort((a, b) => a - b);
      g.font = '600 20px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
      const txt = 'Play:  ' + parts.map(noteName).join('  ');
      const tw = g.measureText(txt).width + 30;
      roundRect(W / 2 - tw / 2, 78, tw, 40, 20); g.fillStyle = 'rgba(26,29,39,0.9)'; g.fill();
      let x = W / 2 - tw / 2 + 15; g.textAlign = 'left';
      g.fillStyle = '#9aa1b8'; g.fillText('Play: ', x, 98); x += g.measureText('Play:  ').width;
      for (const m of parts) { g.fillStyle = c.got.has(m) ? '#3ddc84' : '#fff'; const s = noteName(m) + '  '; g.fillText(s, x, 98); x += g.measureText(s).width; }
    }
  }
  // hit line
  const grd = g.createLinearGradient(0, hitY - 14, 0, hitY);
  grd.addColorStop(0, 'rgba(79,140,255,0)'); grd.addColorStop(1, waiting ? 'rgba(61,220,132,0.45)' : 'rgba(79,140,255,0.35)');
  g.fillStyle = grd; g.fillRect(0, hitY - 14, W, 14);
  drawKeyboard(c);
}

function keyState(m, c) {
  const p = S.pressed.get(m);
  if (p) return p.ok ? 'ok' : 'bad';
  if (S.song && S.armed && c && c.midis.includes(m) && !c.got.has(m)) {
    const n = c.idx.map(i => S.song.notes[i]).find(n => n.midi === m);
    return 'want-' + (n ? n.hand : 'right');
  }
  // light keys for auto-played / listen notes that are sounding
  if (S.song && S.mode === 'listen') {
    for (const i of S.hits) { const n = S.song.notes[i]; if (n.midi === m && n.start <= S.t && n.start + n.dur > S.t) return 'want-' + n.hand; }
  }
  return null;
}

function drawKeyboard(c) {
  const now = performance.now();
  for (const [m, p] of S.pressed) if (p.until < now) S.pressed.delete(m);
  const fill = (st, black) => st === 'ok' ? '#3ddc84' : st === 'bad' ? '#ff5d6c'
    : st && st.startsWith('want') ? rgba(COL[st.slice(5)], black ? 0.9 : 0.55) : (black ? '#15171d' : '#f3f4f7');
  for (const [m, k] of keyRects) if (!k.black) {
    g.fillStyle = fill(keyState(m, c), false);
    g.fillRect(k.x + 0.5, hitY, k.w - 1, kbH);
    g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(k.x + k.w - 0.5, hitY, 1, kbH);
    if (S.opts.names) {
      g.fillStyle = m % 12 === 0 ? '#4f5670' : '#9aa1b8';
      g.font = `${m % 12 === 0 ? 600 : 400} ${Math.max(9, Math.min(13, k.w * 0.42))}px system-ui`;
      g.textAlign = 'center'; g.textBaseline = 'bottom';
      g.fillText(m % 12 === 0 ? noteName(m) : NAMES[m % 12], k.x + k.w / 2, H - 6);
    }
  }
  for (const [m, k] of keyRects) if (k.black) {
    const st = keyState(m, c);
    roundRect(k.x, hitY - 2, k.w, kbH * 0.62, 3);
    g.fillStyle = fill(st, true); g.fill();
    if (!st) { g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(k.x + 2, hitY + kbH * 0.62 - 10, k.w - 4, 6); }
  }
  g.fillStyle = '#000'; g.fillRect(0, hitY - 2, W, 2);
}

function keyAt(x, y) {
  if (y < hitY) return null;
  for (const [m, k] of keyRects) if (k.black && y < hitY + kbH * 0.62 && x >= k.x && x < k.x + k.w) return m;
  for (const [m, k] of keyRects) if (!k.black && x >= k.x && x < k.x + k.w) return m;
  return null;
}

// ---------------------------------------------------------------- main loop
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  listener.update();
  pruneChord(activeChord(), now);
  tick(dt);
  render(now);
  updateProgress();
  if ($('#dlgInput').open) $('#micLevel').style.width = (listener.level * 100).toFixed(0) + '%';
  requestAnimationFrame(frame);
}

function updateProgress() {
  if (!S.song) return;
  const f = (S.t - S.song.start) / Math.max(0.1, S.song.end - S.song.start);
  $('#progressFill').style.width = (Math.max(0, Math.min(1, f)) * 100).toFixed(1) + '%';
  $('#progressLbl').textContent = `${Math.min(S.chordIdx, S.chords.length)} / ${S.chords.length}`;
}

// ---------------------------------------------------------------- UI wiring
let toastTimer;
function toast(msg, ms = 2500) {
  const el = $('#toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}
function updatePlayBtn() { $('#btnPlay').textContent = S.playing ? '⏸' : '▶'; }
function togglePlay() {
  if (!S.song) return openSongs();
  if (S.mode === 'listen') audio();
  if (!S.playing && S.chordIdx >= S.chords.length && S.t >= S.song.end) restart();
  S.playing = !S.playing; updatePlayBtn();
  if (S.playing && S.input === 'mic' && !listener.running) startMic();
}
function setSeg(sel, attr, val) { document.querySelectorAll(`${sel} button`).forEach(b => b.classList.toggle('on', b.dataset[attr] === val)); }

$('#btnPlay').onclick = togglePlay;
$('#btnRestart').onclick = restart;
$('#modeSeg').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  S.mode = b.dataset.mode; store.set('mode', S.mode); setSeg('#modeSeg', 'mode', S.mode);
  if (S.song) { seek(S.t); S.playing = S.mode === 'follow'; updatePlayBtn(); }
  toast({ follow: 'Follow me: notes move only when you play them', wait: 'Wait: notes flow and pause until you play', listen: 'Listen: hear how it goes' }[S.mode]);
};
$('#handSeg').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  S.hand = b.dataset.hand; store.set('hand', S.hand); setSeg('#handSeg', 'hand', S.hand);
  if (S.song) { const t = S.t; buildChords(); seek(t); }
};
function setSpeed(v) {
  S.speed = Math.round(Math.max(0.25, Math.min(1.5, v)) * 100) / 100; store.set('speed', S.speed);
  $('#speedLbl').textContent = Math.round(S.speed * 100) + '%';
}
$('#slower').onclick = () => setSpeed(S.speed - 0.1);
$('#faster').onclick = () => setSpeed(S.speed + 0.1);

// progress scrubbing
(() => {
  const bar = $('#progress');
  const go = e => {
    if (!S.song) return;
    const r = bar.getBoundingClientRect(), f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    seek(S.song.start + f * (S.song.end - S.song.start) - 0.5);
  };
  bar.addEventListener('pointerdown', e => { bar.setPointerCapture(e.pointerId); go(e); bar.onpointermove = go; });
  bar.addEventListener('pointerup', () => { bar.onpointermove = null; });
})();

// on-screen keys
const touches = new Map();
cv.addEventListener('pointerdown', e => {
  const r = cv.getBoundingClientRect(), m = keyAt(e.clientX - r.left, e.clientY - r.top);
  if (m == null) return;
  cv.setPointerCapture(e.pointerId); touches.set(e.pointerId, m);
  if (S.opts.sound && soundAllowed() || S.mode === 'listen') playTone(m);
  handleInput(m, 'touch');
});
const endTouch = e => { const m = touches.get(e.pointerId); if (m != null) { touches.delete(e.pointerId); handleRelease(m, 'touch'); } };
cv.addEventListener('pointerup', endTouch); cv.addEventListener('pointercancel', endTouch);

window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || document.querySelector('dialog[open]')) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'r' || e.key === 'R') restart();
  else if (e.key === 'ArrowRight' && S.song) { advance(); if (S.mode !== 'listen') { const c = activeChord(); if (c && S.t < c.t - 0.5) S.t = c.t - 0.5; } }
  else if (e.key === 'ArrowLeft' && S.song) { const p = S.chords[Math.max(0, S.chordIdx - 1)]; if (p) seek(p.t - 0.6); }
});

// dialogs
document.querySelectorAll('dialog').forEach(d => {
  d.addEventListener('click', e => { if (e.target === d || e.target.closest('[data-close]')) d.close(); });
});

// ---------------------------------------------------------------- inputs
let midiAccess = null;
function setInputLabel() {
  const on = (S.input === 'midi' && midiAccess && [...midiAccess.inputs.values()].length) || (S.input === 'mic' && listener.running);
  $('#inputDot').classList.toggle('on', !!on);
  $('#inputLbl').textContent = S.input === 'midi' ? (on ? 'MIDI piano' : 'MIDI: no device') : S.input === 'mic' ? (on ? 'Microphone' : 'Mic (tap to start)') : 'Connect piano';
  $('#useMidi').classList.toggle('on', S.input === 'midi');
  $('#useMic').classList.toggle('on', S.input === 'mic');
  $('#midiPanel').hidden = S.input !== 'midi';
  $('#micPanel').hidden = S.input !== 'mic';
}
function onMidiMessage(e) {
  const [st, note, vel] = e.data, cmd = st & 0xf0;
  if (cmd === 0x90 && vel > 0) { if (S.opts.sound) playTone(note, 0.6, vel / 127); handleInput(note, 'midi'); }
  else if (cmd === 0x80 || (cmd === 0x90 && vel === 0)) handleRelease(note, 'midi');
}
function bindMidiInputs() {
  if (!midiAccess) return;
  const sel = $('#midiSelect'), inputs = [...midiAccess.inputs.values()];
  const want = store.get('midiDev', null);
  sel.innerHTML = inputs.length ? '' : '<option>No MIDI device found — plug in your piano</option>';
  inputs.forEach(i => { const o = document.createElement('option'); o.value = i.id; o.textContent = i.name; sel.appendChild(o); });
  const chosen = inputs.find(i => i.name === want) || inputs[0];
  if (chosen) sel.value = chosen.id;
  inputs.forEach(i => { i.onmidimessage = (S.input === 'midi' && i === chosen) ? onMidiMessage : null; });
  setInputLabel();
}
$('#midiSelect').onchange = e => {
  const i = midiAccess && midiAccess.inputs.get(e.target.value);
  if (i) store.set('midiDev', i.name); bindMidiInputs();
};
async function startMidi() {
  if (!navigator.requestMIDIAccess) {
    toast(window.isSecureContext ? 'This browser has no MIDI support (e.g. iPad Safari). Use the microphone, or Chrome / Edge.' : 'Open the https:// address shown by the server to use MIDI.', 5000);
    return false;
  }
  try {
    midiAccess = await navigator.requestMIDIAccess();
    midiAccess.onstatechange = bindMidiInputs;
    bindMidiInputs();
    return true;
  } catch (e) { toast('MIDI permission was refused.'); return false; }
}
async function startMic() {
  if (!window.isSecureContext || !navigator.mediaDevices) { toast('The microphone needs the https:// address shown by the server.', 5000); return false; }
  try {
    await listener.start(); setInputLabel();
    toast('Listening… stay quiet for a second while I measure the room.', 2500);
    return true;
  } catch (e) { toast('Microphone permission was refused.'); return false; }
}
$('#btnInput').onclick = () => { setInputLabel(); $('#dlgInput').showModal(); if (S.input === 'mic' && !listener.running) startMic(); };
$('#useMidi').onclick = async () => {
  listener.stop(); S.input = 'midi'; store.set('input', 'midi'); await startMidi(); setInputLabel();
};
$('#useMic').onclick = async () => {
  S.input = 'mic'; store.set('input', 'mic'); bindMidiInputs(); await startMic(); setInputLabel();
};
$('#micSens').value = store.get('sens', 55);
$('#micSens').oninput = e => { store.set('sens', +e.target.value); listener.setSensitivity(e.target.value / 100); };
$('#micCalib').onclick = () => { listener.calibrate(); toast('Measuring room noise — stay quiet…', 1500); };

// ---------------------------------------------------------------- settings
const optEls = { names: '#optNames', fit: '#optFit', sound: '#optSound', other: '#optOther', strict: '#optStrict' };
for (const [k, sel] of Object.entries(optEls)) {
  $(sel).checked = S.opts[k];
  $(sel).onchange = e => { S.opts[k] = e.target.checked; store.set(k, S.opts[k]); if (k === 'fit') computeRange(); };
}
$('#optZoom').value = S.opts.zoom;
$('#optZoom').oninput = e => { S.opts.zoom = +e.target.value; store.set('zoom', S.opts.zoom); };
for (let m = 48; m <= 72; m++) { const o = document.createElement('option'); o.value = m; o.textContent = noteName(m) + (m === 60 ? ' (middle C)' : ''); $('#optSplit').appendChild(o); }
$('#optSplit').value = S.opts.split;
$('#optSplit').onchange = e => {
  S.opts.split = +e.target.value; store.set('split', S.opts.split);
  if (S.song) { assignHands(S.song); const t = S.t; buildChords(); seek(t); }
};
$('#btnSettings').onclick = () => $('#dlgSettings').showModal();

// ---------------------------------------------------------------- library (server or on-device)
const idb = {
  db: null,
  async open() {
    if (this.db) return this.db;
    return this.db = await new Promise((res, rej) => {
      const r = indexedDB.open('piano-trainer', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('songs');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  },
  async tx(mode, fn) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction('songs', mode); const r = fn(t.objectStore('songs')); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); }); },
  put(name, buf) { return this.tx('readwrite', s => s.put({ buf, added: Date.now() }, name)); },
  del(name) { return this.tx('readwrite', s => s.delete(name)); },
  async list() { const db = await this.open(); return new Promise(res => { const out = []; const c = db.transaction('songs').objectStore('songs').openCursor(); c.onsuccess = () => { const cur = c.result; if (cur) { out.push({ name: cur.key, added: cur.value.added }); cur.continue(); } else res(out.sort((a, b) => b.added - a.added)); }; }); },
  get(name) { return this.tx('readonly', s => s.get(name)).then(v => v && v.buf); },
};
const lib = {
  async list() {
    if (S.server) { const r = await fetch('api/songs'); return (await r.json()).map(s => s.name); }
    return (await idb.list()).map(s => s.name);
  },
  async save(name, buf) {
    if (S.server) {
      const r = await fetch('api/songs?name=' + encodeURIComponent(name), { method: 'POST', body: buf });
      const j = await r.json(); if (!r.ok) throw new Error(j.error); return j.name;
    }
    name = name.replace(/\.(mid|midi)$/i, '') + '.mid'; await idb.put(name, buf); return name;
  },
  async load(name) {
    if (S.server) { const r = await fetch('songs/' + encodeURIComponent(name)); if (!r.ok) throw new Error('Song not found'); return r.arrayBuffer(); }
    return idb.get(name);
  },
  async del(name) {
    if (S.server) await fetch('api/songs/' + encodeURIComponent(name), { method: 'DELETE' }); else await idb.del(name);
  },
};

async function refreshList() {
  const ul = $('#songList'); ul.innerHTML = '';
  const add = (name, tag, onPick, onDel) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="nm"></span><span class="tag">${tag}</span>`;
    li.querySelector('.nm').textContent = name;
    li.onclick = onPick;
    if (onDel) {
      const b = document.createElement('button'); b.className = 'del'; b.textContent = '🗑'; b.title = 'Delete';
      b.onclick = e => { e.stopPropagation(); if (confirm(`Delete "${name}"?`)) onDel().then(refreshList); };
      li.appendChild(b);
    }
    ul.appendChild(li);
  };
  let saved = [];
  try { saved = await lib.list(); } catch {}
  for (const name of saved) add(name.replace(/\.mid$/i, ''), S.server ? 'Library' : 'This device', () => pickSaved(name), () => lib.del(name));
  DEMOS.forEach((mk, i) => { const s = mk(); add(s.name, 'Built-in', () => { loadSong(s); store.set('last', { demo: i }); $('#dlgSongs').close(); }); });
}
async function pickSaved(name) {
  try {
    const buf = await lib.load(name);
    loadSong(songFromMidi(name, buf)); store.set('last', { name }); $('#dlgSongs').close();
  } catch (e) { toast('Could not open that song: ' + e.message, 4000); }
}
function openSongs() { refreshList(); $('#dlgSongs').showModal(); }
$('#btnSongs').onclick = openSongs;
$('#emptySongs').onclick = openSongs;

$('#fileMidi').onchange = async e => {
  let first = null;
  for (const f of e.target.files) {
    try {
      const buf = await f.arrayBuffer();
      songFromMidi(f.name, buf.slice(0)); // validate
      const name = await lib.save(f.name, buf);
      first = first || name;
    } catch (err) { toast(`${f.name}: ${err.message}`, 4000); }
  }
  e.target.value = '';
  if (first) pickSaved(first);
};

// ---------------------------------------------------------------- audio -> MIDI (Spotify basic-pitch)
function showConvert(label, frac) {
  $('#convert').hidden = false; $('#convLbl').textContent = label;
  $('#convFill').style.width = Math.round(frac * 100) + '%';
}
async function transcribe(buf, title) {
  const V = window.PianoVendor;
  showConvert('Decoding audio…', 0.02);
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  let decoded;
  try { decoded = await new Promise((res, rej) => { const p = ac.decodeAudioData(buf, res, rej); if (p && p.then) p.then(res, rej); }); }
  finally { ac.close(); }
  // optional From / To trim (m:ss or seconds)
  const parseT = s => { s = (s || '').trim(); if (!s) return null; const p = s.split(':').map(Number); return p.some(isNaN) ? null : p.reduce((a, x) => a * 60 + x, 0); };
  const from = Math.max(0, parseT($('#trimFrom').value) || 0);
  const to = Math.min(decoded.duration, parseT($('#trimTo').value) || decoded.duration);
  if (to - from < 1) throw new Error('The From / To times leave no audio to convert.');
  const len = Math.ceil((to - from) * 22050);
  const off = new OfflineAudioContext(1, len, 22050);
  const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start(0, from, to - from);
  const pcm = (await off.startRendering()).getChannelData(0);
  showConvert('Listening for notes… (this can take a minute)', 0.05);
  // Use the graphics card (fast). If its driver can't run the model, fall back to the processor (slower, reliable).
  let frames, onsets, contours;
  const run = async () => {
    frames = []; onsets = []; contours = [];
    const bp = new V.BasicPitch('model/model.json');
    const cpu = V.tf.getBackend() === 'cpu' ? ' (using processor — slower)' : '';
    await bp.evaluateModel(pcm, (f, o, c) => { frames.push(...f); onsets.push(...o); contours.push(...c); },
      p => showConvert(`Listening for notes… ${Math.round(p * 100)}%${cpu}`, 0.05 + p * 0.9));
  };
  if (store.get('cpuOnly', false)) await V.tf.setBackend('cpu');
  try { await run(); }
  catch (e) {
    if (V.tf.getBackend() === 'cpu') throw e;
    console.warn('GPU transcription failed, retrying on CPU:', e);
    store.set('cpuOnly', true);
    await V.tf.setBackend('cpu');
    await run();
  }
  const events = V.noteFramesToTime(V.addPitchBendsToNoteEvents(contours,
    V.outputToNotesPoly(frames, onsets, 0.5, 0.3, 8, true, null, null, true)));
  const notes = events.filter(e => e.pitchMidi >= 21 && e.pitchMidi <= 108 && e.durationSeconds >= 0.06);
  if (!notes.length) throw new Error('No piano notes were found in that audio.');
  const midi = new V.Midi();
  const tr = midi.addTrack(); tr.name = 'Piano';
  for (const n of notes) tr.addNote({ midi: n.pitchMidi, time: n.startTimeSeconds, duration: n.durationSeconds, velocity: Math.min(1, 0.35 + n.amplitude * 0.65) });
  showConvert('Saving…', 0.98);
  const name = await lib.save(title, midi.toArray().buffer);
  showConvert(`Done — ${notes.length} notes found.`, 1);
  setTimeout(() => { $('#convert').hidden = true; }, 2500);
  return name;
}
async function runConvert(getBuf, title) {
  try {
    let buf = await getBuf();
    if (buf && buf.buf) { title = buf.title; buf = buf.buf; }
    const name = await transcribe(buf, title);
    await pickSaved(name);
    toast('Converted! Tip: try Listen mode first to check it.', 4000);
  } catch (e) {
    showConvert('⚠ ' + (e.message || e), 0);
  }
}
$('#fileAudio').onchange = e => {
  const f = e.target.files[0]; e.target.value = '';
  if (f) runConvert(() => f.arrayBuffer(), f.name.replace(/\.[^.]+$/, ''));
};
$('#btnYouTube').onclick = () => {
  const box = $('#ytBox'); box.hidden = !box.hidden;
  $('#ytUrl').hidden = $('#ytGo').hidden = !S.server;
  $('#ytHint').innerHTML = !S.server
    ? '<b>On the tablet:</b> 1) In the YouTube app tap <b>Share → Seal</b> and download the <b>audio</b>. ' +
      '2) In Seal, tap the finished download → <b>Share → Piano Trainer</b>. ' +
      '3) Set From / To above (e.g. 0:00 – 1:00) and tap Convert.<br>' +
      'Or use <b>♪ From audio file</b> and pick the downloaded file. Get Seal free from its GitHub page: github.com/JunkFood02/Seal'
    : !S.server.ytdlp ? 'yt-dlp is not installed on the computer running the helper. Run:  winget install yt-dlp.yt-dlp  then restart the helper.'
    : 'Works best with Synthesia-style or solo-piano videos. The audio is turned into notes on this device.';
  if (!box.hidden) $('#ytUrl').focus();
};
$('#ytGo').onclick = () => {
  const url = $('#ytUrl').value.trim();
  if (!url) return;
  if (!S.server) return toast('Start the helper (start.bat) first.');
  runConvert(async () => {
    showConvert('Downloading audio from YouTube… (up to a minute)', 0.01);
    const r = await fetch('api/youtube?url=' + encodeURIComponent(url));
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    const a = await fetch(j.audio);
    return { buf: await a.arrayBuffer(), title: j.title || 'YouTube song' };
  }, 'YouTube song');
};

// ---------------------------------------------------------------- files shared from other apps (Seal, Files, Drive…)
async function handleShared() {
  history.replaceState(null, '', location.pathname);
  try {
    const c = await caches.open('pt-share');
    const res = await c.match('shared-file');
    const txt = await c.match('shared-text');
    await c.delete('shared-file'); await c.delete('shared-text');
    if (!res) {
      const t = txt ? await txt.text() : '';
      openSongs();
      if (/youtu/.test(t)) { $('#btnYouTube').click(); toast('Download the audio with Seal first, then share the file to Piano Trainer.', 6000); }
      return;
    }
    const name = decodeURIComponent(res.headers.get('x-name') || 'Shared song');
    const buf = await res.arrayBuffer();
    if (/\.midi?$/i.test(name) || new Uint8Array(buf.slice(0, 4)).join() === '77,84,104,100') {
      songFromMidi(name, buf.slice(0));
      await pickSaved(await lib.save(name, buf));
      return;
    }
    openSongs();
    const box = $('#shareBox');
    box.hidden = false;
    $('#shareName').textContent = name;
    $('#shareGo').onclick = () => { box.hidden = true; runConvert(async () => buf, name.replace(/\.[^.]+$/, '')); };
  } catch (e) { toast('Could not open the shared file: ' + e.message, 5000); }
}

// ---------------------------------------------------------------- startup
(async () => {
  setSeg('#modeSeg', 'mode', S.mode); setSeg('#handSeg', 'hand', S.hand); setSpeed(S.speed);
  computeRange();
  try { const r = await fetch('api/status', { cache: 'no-store' }); if (r.ok) { const j = await r.json(); if (j && j.server === true) S.server = j; } } catch {}
  // offline support + "Share to Piano Trainer" (installed app)
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (new URLSearchParams(location.search).has('share')) handleShared();
  if (S.input === 'midi') startMidi();
  // browsers only allow the microphone after a tap/click, so start it on the first one
  document.addEventListener('pointerdown', function once() {
    document.removeEventListener('pointerdown', once, true);
    if (S.input === 'mic' && !listener.running) startMic();
  }, true);
  setInputLabel();
  const lastSong = store.get('last', null);
  try {
    if (lastSong && lastSong.demo != null && DEMOS[lastSong.demo]) loadSong(DEMOS[lastSong.demo]());
    else if (lastSong && lastSong.name) { const buf = await lib.load(lastSong.name); if (buf) loadSong(songFromMidi(lastSong.name, buf)); }
  } catch {}
  requestAnimationFrame(frame);
  // test hook (used for automated checks)
  window.__pt = { S, listener, handleInput, handleRelease, loadSong, songFromMidi, DEMOS, tick, render, seek, transcribe };
})();
})();

// ---------------------------------------------------------------- full screen button
(() => {
  const btn = document.querySelector('#btnFull');
  const el = document.documentElement;
  const isFull = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
  if (!(el.requestFullscreen || el.webkitRequestFullscreen)) { btn.hidden = true; return; }
  btn.onclick = async () => {
    try {
      if (isFull()) await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else await (el.requestFullscreen || el.webkitRequestFullscreen).call(el, { navigationUI: 'hide' });
    } catch (e) { console.warn(e); }
  };
  const sync = () => { btn.textContent = isFull() ? '✕ Exit full' : '⛶ Full screen'; setTimeout(() => window.dispatchEvent(new Event('resize')), 200); };
  document.addEventListener('fullscreenchange', sync); document.addEventListener('webkitfullscreenchange', sync);
  sync();
})();
