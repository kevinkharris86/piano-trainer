// Developer self-test for the chord listener.
// Open the app, then in the browser console run:  await import('./tests/mic-selftest.js').then(m => m.runAll())
// It synthesises piano-like tones (harmonics, decay, hammer click, room noise) offline and feeds
// them through the real MicListener, checking which chords are recognised.

export async function runSeq(chords, strikes, opts = {}) {
  const sr = 48000, dur = opts.dur || 3.0;
  const ctx = new OfflineAudioContext(1, sr * dur, sr);
  const out = ctx.createGain();
  const nb = ctx.createBuffer(1, sr * dur, sr), d = nb.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (opts.noise ?? 0.004);
  for (const s of strikes) { const i0 = Math.floor(s.at * sr); for (let i = 0; i < 240; i++) d[i0 + i] += (Math.random() * 2 - 1) * 0.05 * (s.vel || 0.3) / 0.3 * Math.exp(-i / 60); }
  const ns = ctx.createBufferSource(); ns.buffer = nb; ns.connect(out); ns.start(0);
  const voices = {};
  for (const s of [...strikes].sort((a, b) => a.at - b.at)) for (const m of s.notes) {
    if (voices[m]) voices[m].gain.setTargetAtTime(0, s.at, 0.01);
    const f = 440 * Math.pow(2, (m - 69) / 12);
    const vg = ctx.createGain(); vg.connect(out); voices[m] = vg;
    for (let h = 1; h <= 10; h++) {
      const fh = f * h * Math.sqrt(1 + 0.0004 * h * h); if (fh > 10000) break;
      const o = ctx.createOscillator(); o.frequency.value = fh;
      const g = ctx.createGain();
      const amp = (s.vel || 0.3) * (m < 48 && h === 1 ? 0.3 : 1) / Math.pow(h, 1.1);
      g.gain.setValueAtTime(0, s.at); g.gain.linearRampToValueAtTime(amp, s.at + 0.004);
      g.gain.setTargetAtTime(0, s.at + 0.01, (opts.decay || 0.6) / (1 + h * 0.3));
      o.connect(g).connect(vg); o.start(s.at);
    }
  }
  const L = new MicListener(); L.setSensitivity((opts.sens ?? 55) / 100);
  L.startWithNode(out);
  const log = []; let ci = 0, got = new Set(), cur = 0;
  L.onHeard = m => {
    log.push(`${cur.toFixed(2)}:${m}`); got.add(m);
    if (chords[ci] && chords[ci].every(x => got.has(x))) { log.push(`[✓${ci}]`); ci++; got = new Set(); L.setExpected(chords[ci] || []); }
  };
  const step = 1 / 60;
  for (let t = step; t < dur - 0.02; t += step) {
    const tt = Math.round(t * sr / 128) * 128 / sr;
    ctx.suspend(tt).then(() => {
      cur = tt;
      if (tt < 0.4) { L.calibrating = performance.now() + 1e6; L.update(tt * 1000); }
      else if (L.calibrating) { L.calibrating = 1; L.update(tt * 1000); L.setExpected(chords[0]); }
      else L.update(tt * 1000);
      if (opts.onFrame) opts.onFrame(L, tt);
      ctx.resume();
    }).catch(() => {});
  }
  await ctx.startRendering();
  return { done: ci, log: log.join(' ') };
}

const one = (exp, notes, o) => runSeq([exp], notes.length ? [{ at: 0.8, notes }] : [], o);
const seq = (chords, times, o) => runSeq(chords, chords.map((c, i) => ({ at: times[i], notes: c })).filter(s => s.at != null), o);

export const CASES = {
  'C major chord': [1, () => one([60, 64, 67], [60, 64, 67])],
  'both hands C chord': [1, () => one([48, 60, 64, 67], [48, 60, 64, 67])],
  'low bass fifth': [1, () => one([36, 43], [36, 43])],
  'high chord': [1, () => one([84, 88, 91], [84, 88, 91])],
  'cluster C D E': [1, () => one([60, 62, 64], [60, 62, 64])],
  'octaves C3 C4 C5': [1, () => one([48, 60, 72], [48, 60, 72])],
  'soft playing': [1, () => runSeq([[60, 64, 67]], [{ at: 0.8, notes: [60, 64, 67], vel: 0.05 }], { dur: 1.6 })],
  'noisy room': [2, () => seq([[60, 64, 67], [65, 69, 72]], [0.8, 1.8], { dur: 2.6, noise: 0.02 })],
  'REJECT partial chord (C E only)': [0, () => one([60, 64, 67], [60, 64])],
  'REJECT wrong semitone': [0, () => one([60], [61])],
  'REJECT octave below': [0, () => one([72], [60])],
  'REJECT wrong chord (Dm for C)': [0, () => one([60, 64, 67], [62, 65, 69])],
  'REJECT silence': [0, () => one([60, 64, 67], [])],
  'repeated notes C C G G': [4, () => seq([[60], [60], [67], [67]], [0.8, 1.4, 2.0, 2.6], { dur: 3.2 })],
  'repeated notes, long sustain': [4, () => seq([[60], [60], [67], [67]], [0.8, 1.4, 2.0, 2.6], { dur: 3.2, decay: 2.5 })],
  'fast repeats (4/sec)': [4, () => seq([[64], [64], [64], [64]], [0.8, 1.05, 1.3, 1.55], { dur: 2.2, decay: 1.5 })],
  'REJECT held note reused (no re-strike)': [1, () => runSeq([[60, 64, 67], [64]], [{ at: 0.8, notes: [60, 64, 67] }], { dur: 2.6, decay: 2.5 })],
  'ringing note then re-strike': [2, () => runSeq([[60, 64, 67], [64]], [{ at: 0.8, notes: [60, 64, 67] }, { at: 1.6, notes: [64] }], { dur: 2.4, decay: 2.5 })],
  'progression C F G C (both hands, sustained)': [4, () => seq([[48, 60, 64, 67], [41, 60, 65, 69], [43, 59, 62, 67], [48, 60, 64, 67]], [0.8, 1.5, 2.2, 2.9], { dur: 3.6, decay: 2.0 })],
};

export async function runAll() {
  const out = {};
  let pass = 0, total = 0;
  for (const [name, [want, fn]] of Object.entries(CASES)) {
    const r = await fn(); total++;
    const ok = r.done === want; if (ok) pass++;
    out[(ok ? 'PASS ' : 'FAIL ') + name] = `${r.done}/${want}  ${r.log}`;
  }
  out.summary = `${pass}/${total} passed`;
  return out;
}
