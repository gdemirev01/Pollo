// A small additive "piano" synth on the Web Audio API.
// Voices are keyed by an id (the finger) so two fingers on one key don't cut each other off.

export class PianoSynth {
  constructor() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.7;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;

    // Simple reverb from a generated impulse response.
    this.reverb = this.ctx.createConvolver();
    this.reverb.buffer = this.#impulse(2.2, 2.5);
    this.wet = this.ctx.createGain();
    this.wet.gain.value = 0.22;

    this.bus = this.ctx.createGain();
    this.bus.connect(comp);
    this.bus.connect(this.reverb);
    this.reverb.connect(this.wet);
    this.wet.connect(comp);
    comp.connect(this.master);
    this.master.connect(this.ctx.destination);

    this.voices = new Map(); // id -> voice
    this.sustain = false;
    this.sustained = new Set();
    this.noise = this.#noiseBuffer();
  }

  resume() { return this.ctx.resume(); }
  set volume(v) { this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02); }
  set reverbAmount(v) { this.wet.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02); }

  noteOn(midi, velocity = 0.8, id = `k${midi}`) {
    if (this.voices.has(id)) this.#release(this.voices.get(id), 0.05);
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const f0 = 440 * Math.pow(2, (midi - 69) / 12);

    const out = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = Math.min(16000, f0 * (4 + velocity * 14));
    filter.Q.value = 0.5;
    filter.connect(out);
    out.connect(this.bus);

    // Lower notes ring longer.
    const decay = 1.2 + 4 * Math.max(0, (84 - midi) / 48);
    const peak = 0.22 * velocity;
    out.gain.setValueAtTime(0, now);
    out.gain.linearRampToValueAtTime(peak, now + 0.004);
    out.gain.setTargetAtTime(peak * 0.35, now + 0.004, 0.12);
    out.gain.setTargetAtTime(0.0001, now + 0.25, decay / 3);

    const B = 0.0004; // inharmonicity
    const partials = [[1, 1], [2, 0.45], [3, 0.22], [4, 0.12], [5, 0.06], [6, 0.03]];
    const oscs = [];
    for (const [n, amp] of partials) {
      const f = f0 * n * Math.sqrt(1 + B * n * n);
      if (f > 18000) continue;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(amp, now);
      // Upper partials fade faster, which is what makes it sound struck.
      g.gain.setTargetAtTime(amp * 0.2, now, decay / (n * 1.5));
      o.connect(g).connect(filter);
      o.start(now);
      oscs.push(o);
    }

    // Hammer thump.
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = Math.min(8000, f0 * 3);
    bp.Q.value = 1.2;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.25 * velocity, now);
    ng.gain.exponentialRampToValueAtTime(0.0001, now + 0.04);
    src.connect(bp).connect(ng).connect(out);
    src.start(now);
    src.stop(now + 0.05);

    const voice = { id, midi, out, oscs, released: false };
    this.voices.set(id, voice);
    // Auto-cleanup once the note has decayed away.
    voice.timer = setTimeout(() => this.#release(voice, 0.1), (decay * 2.5 + 0.5) * 1000);
    return voice;
  }

  noteOff(id) {
    const v = this.voices.get(id);
    if (!v) return;
    if (this.sustain) { this.sustained.add(v); this.voices.delete(id); return; }
    this.#release(v, 0.25);
  }

  setSustain(on) {
    this.sustain = on;
    if (!on) { for (const v of this.sustained) this.#release(v, 0.35); this.sustained.clear(); }
  }

  allOff() {
    for (const v of this.voices.values()) this.#release(v, 0.1);
    for (const v of this.sustained) this.#release(v, 0.1);
    this.sustained.clear();
  }

  #release(v, time) {
    if (v.released) return;
    v.released = true;
    clearTimeout(v.timer);
    if (this.voices.get(v.id) === v) this.voices.delete(v.id);
    const now = this.ctx.currentTime;
    v.out.gain.cancelScheduledValues(now);
    v.out.gain.setValueAtTime(v.out.gain.value, now);
    v.out.gain.setTargetAtTime(0, now, time / 4);
    for (const o of v.oscs) o.stop(now + time + 0.1);
    setTimeout(() => v.out.disconnect(), (time + 0.2) * 1000);
  }

  #noiseBuffer() {
    const len = Math.floor(this.ctx.sampleRate * 0.1);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  #impulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }
}
