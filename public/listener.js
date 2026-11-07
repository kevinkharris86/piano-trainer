// Microphone listener that hears single notes AND chords.
//
// General polyphonic transcription is hard, but a practice app knows which notes it is
// waiting for, so each expected note is checked on its own, all at the same time:
//
//  1. PITCH (long ~340 ms FFT, fine frequency resolution): is this exact note sounding?
//     - energy at its fundamental + overtones is well above the room's noise floor
//     - its own fundamental is present (so overtones of other chord notes don't count)
//     - it is clearly stronger than the semitones either side (wrong notes / noise)
//     - it isn't just the overtone of the same note an octave lower
//  2. ATTACK (short ~43 ms FFT, fine time resolution): was this note just struck?
//     Every strike can be used once, so a held/ringing note never counts twice and
//     repeated notes (C C G G…) need a real second strike.
(function () {
  const midiFreq = m => 440 * Math.pow(2, (m - 69) / 12);
  const lerp = (a, b, t) => a + (b - a) * t;
  const dB = p => 10 * Math.log10(p + 1e-12);

  class MicListener {
    constructor() {
      this.ctx = null; this.stream = null; this.running = false;
      this.expected = new Map();      // midi -> { heard }
      this.activatedAt = 0;
      this.noise = new Map();         // midi -> { s, f, a } noise floors (dB)
      this.attack = new Map();        // midi -> { hist:[{t,v}], rising, at, used }
      this.sens = 0.55; this.level = 0; this.lastNow = 0;
      this.onHeard = null;
      this.calibrating = 0; this.calibData = new Map();
    }

    async start() {
      if (this.running) return;
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      this._attach(this.ctx.createMediaStreamSource(this.stream));
      this.calibrate();
    }

    // For testing: feed any audio node instead of the microphone.
    startWithNode(node) { this.ctx = node.context; this._attach(node); }

    _attach(src) {
      const mk = size => {
        const a = this.ctx.createAnalyser();
        a.fftSize = size; a.smoothingTimeConstant = 0; a.minDecibels = -130; a.maxDecibels = 0;
        src.connect(a);
        return { a, spec: new Float32Array(a.frequencyBinCount), pow: new Float32Array(a.frequencyBinCount), binHz: this.ctx.sampleRate / size };
      };
      this.long = mk(16384);
      this.short = mk(2048);
      this.time = new Float32Array(2048);
      this.running = true;
    }

    stop() {
      if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); if (this.ctx) this.ctx.close(); }
      this.running = false; this.stream = null; this.ctx = null;
    }

    // Allow a note to be heard again (used when a chord note timed out before the rest were played)
    rearm(m) { const st = this.expected.get(m); if (st) st.heard = false; else this.expected.set(m, { heard: false }); }

    setSensitivity(v) { this.sens = Math.max(0, Math.min(1, v)); }
    calibrate(seconds = 1.2) { this.calibrating = performance.now() + seconds * 1000; this.calibData = new Map(); }

    // Notes the song is waiting for right now (one note or a whole chord).
    setExpected(notes) {
      this.expected = new Map(notes.map(m => [m, { heard: false }]));
      this.activatedAt = this.lastNow;
    }

    _read(an) {
      an.a.getFloatFrequencyData(an.spec);
      for (let i = 0; i < an.spec.length; i++) an.pow[i] = Math.pow(10, an.spec[i] / 10);
    }

    // Peak power near frequency f.
    _peak(an, f, cents) {
      if (f >= this.ctx.sampleRate * 0.47) return 0;
      const r = Math.pow(2, cents / 1200), c = Math.round(f / an.binHz);
      const lo = Math.min(c, Math.floor(f / r / an.binHz)), hi = Math.max(c, Math.ceil(f * r / an.binHz));
      let best = 0;
      for (let i = Math.max(1, lo); i <= hi && i < an.pow.length; i++) if (an.pow[i] > best) best = an.pow[i];
      return best;
    }

    _salience(an, m, cents = 30) {
      const f0 = midiFreq(m), W = [1, 0.9, 0.75, 0.6, 0.5, 0.4];
      let s = 0;
      for (let h = 1; h <= W.length && f0 * h < 6000; h++) s += W[h - 1] * this._peak(an, f0 * h, h <= 2 ? cents : cents * 1.5);
      return s;
    }
    _fund(m) {
      const f0 = midiFreq(m);
      // low piano strings have weak fundamentals, so accept the 2nd harmonic for bass notes
      return m < 45 ? Math.max(this._peak(this.long, f0, 30), this._peak(this.long, f0 * 2, 30)) : this._peak(this.long, f0, 30);
    }

    // Call about once per animation frame.
    update(nowMs) {
      if (!this.running) return;
      const now = nowMs != null ? nowMs : performance.now();
      this.lastNow = now;
      this.short.a.getFloatTimeDomainData(this.time);
      let rms = 0;
      for (let i = 0; i < this.time.length; i++) rms += this.time[i] * this.time[i];
      this.level = Math.min(1, Math.sqrt(rms / this.time.length) * 8);
      this._read(this.long); this._read(this.short);

      if (this.calibrating) {
        for (let m = 21; m <= 108; m++) {
          const d = this.calibData.get(m) || { s: [], f: [], a: [] };
          d.s.push(dB(this._salience(this.long, m))); d.f.push(dB(this._fund(m))); d.a.push(dB(this._salience(this.short, m, 0)));
          this.calibData.set(m, d);
        }
        if (now > this.calibrating) {
          const p90 = arr => arr.sort((x, y) => x - y)[Math.floor(arr.length * 0.9)];
          for (const [m, d] of this.calibData) this.noise.set(m, { s: p90(d.s), f: p90(d.f), a: p90(d.a) });
          this.calibrating = 0;
        }
        return;
      }

      const thr = lerp(30, 8, this.sens);    // dB above the room noise
      const riseA = lerp(7, 2.5, this.sens); // dB jump in the short window = a strike
      const ratio = lerp(4, 1.6, this.sens); // must beat neighbour semitones by this factor

      // --- hammer "click": a broadband jump in 1.5–8 kHz marks that *some* key was struck.
      // Lets us catch re-strikes of a note that is still ringing (its own level only rises a little).
      {
        const sh = this.short, lo = Math.floor(1500 / sh.binHz), hi = Math.min(sh.pow.length - 1, Math.ceil(8000 / sh.binHz));
        let e = 0; for (let i = lo; i <= hi; i++) e += sh.pow[i];
        const v = dB(e);
        this.bb = this.bb || { hist: [], rising: false, at: -1e9 };
        let mn = Infinity; for (const h of this.bb.hist) if (h.v < mn) mn = h.v;
        const isRise = v - mn >= 4;
        if (isRise && !this.bb.rising) this.bb.at = now;
        this.bb.rising = isRise;
        this.bb.hist.push({ t: now, v });
        while (this.bb.hist.length > 1 && this.bb.hist[0].t < now - 70) this.bb.hist.shift();
      }
      const click = now - this.bb.at < 60;

      // --- attack detection for every key (cheap), so a strike just before a chord appears still counts
      for (let m = 21; m <= 108; m++) {
        const v = dB(this._salience(this.short, m, 0));
        let st = this.attack.get(m);
        if (!st) { st = { hist: [], rising: false, at: -1e9, used: -1e9 }; this.attack.set(m, st); }
        let mn = Infinity;
        for (const h of st.hist) if (h.v < mn) mn = h.v;
        const nf = this.noise.has(m) ? this.noise.get(m).a : -110;
        const isRise = (v - mn >= riseA || (click && v - mn >= 1.2)) && v >= nf + thr * 0.6;
        if (isRise && !st.rising) st.at = now;      // rising edge = one strike
        st.rising = isRise;
        st.hist.push({ t: now, v });
        while (st.hist.length > 1 && st.hist[0].t < now - 70) st.hist.shift();
      }
      if (!this.expected.size) return;

      // energy at f explained by an overtone of another expected note?
      const explained = f => {
        for (const e of this.expected.keys()) {
          const r = f / midiFreq(e), h = Math.round(r);
          if (h >= 1 && Math.abs(1200 * Math.log2(r / h)) < 40) return true;
        }
        return false;
      };

      // loudest component right now — weak "leakage" far below it is not a played note
      let gp = 0;
      { const L = this.long, a = Math.floor(25 / L.binHz), b = Math.ceil(5000 / L.binHz);
        for (let i = a; i <= b; i++) if (L.pow[i] > gp) gp = L.pow[i]; }
      const gpDb = dB(gp);

      for (const [m, st] of this.expected) {
        if (st.heard) continue;
        const at = this.attack.get(m);
        // a fresh, unused strike from (at most 150 ms before) this chord appearing
        if (!at || at.at <= at.used || at.at < this.activatedAt - 150 || now - at.at > 450) continue;
        const nf = this.noise.get(m) || { s: -110, f: -110 };
        const s = this._salience(this.long, m);
        if (dB(s) < nf.s + thr) continue;
        const fp = this._fund(m), fdb = dB(fp);
        if (fdb < nf.f + thr * 0.8 || fdb < gpDb - 40) continue;
        if (fp < s * 0.08) continue;   // mostly overtones of other notes, not this one
        let nb = 0;
        for (const d of [-1, 1]) if (!this.expected.has(m + d)) nb = Math.max(nb, this._salience(this.long, m + d));
        if (s < nb * ratio) continue;
        const f0 = midiFreq(m);
        if (m - 12 >= 21 && !explained(f0 / 2) && this._peak(this.long, f0 / 2, 30) > this._peak(this.long, f0, 30) * 0.35) continue;
        st.heard = true;
        at.used = at.at;
        if (this.onHeard) this.onHeard(m);
      }
    }
  }

  window.MicListener = MicListener;
})();
