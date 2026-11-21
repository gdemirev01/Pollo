import { buildLayout, isBlack } from './piano.js';
import { createDetector, FINGERTIPS } from './detector.js';
import { PianoSynth } from './synth.js';
import { createHandTracker } from './hands.js';

const $ = (s) => document.querySelector(s);
const video = $('#video');
const canvas = $('#canvas');
const g = canvas.getContext('2d');
const statusEl = $('#status');

const settings = {
  mode: 'tap',
  startMidi: 60,
  whiteCount: 14,
  showSkeleton: true,
};

let layout = makeLayout();
const detector = createDetector({ mode: settings.mode });
let synth = null;
let tracker = null;
let hands = [];
let active = new Map();
const flashes = new Map(); // midi -> time of last hit, for a visual pop
const kbdHeld = new Set();

function makeLayout() { return buildLayout({ startMidi: settings.startMidi, whiteCount: settings.whiteCount }); }
function setStatus(t, cls = '') { statusEl.textContent = t; statusEl.className = cls; }

function handle(events) {
  for (const e of events) {
    if (e.type === 'on') { synth?.noteOn(e.midi, e.velocity, e.finger); flashes.set(e.midi, performance.now()); }
    else synth?.noteOff(e.finger);
  }
}

// ---------- controls ----------
function bind(id, key, parse = (v) => v, after) {
  const el = $(id);
  el.addEventListener('input', () => { settings[key] = parse(el.type === 'checkbox' ? el.checked : el.value); after?.(); });
}
bind('#mode', 'mode', String, () => { handle(detector.reset()); detector.setOptions({ mode: settings.mode }); updateHint(); });
bind('#octave', 'startMidi', Number, relayout);
bind('#keys', 'whiteCount', Number, relayout);
bind('#skeleton', 'showSkeleton', Boolean);
$('#sensitivity').addEventListener('input', (e) => {
  const v = Number(e.target.value); // 1..10, higher = more sensitive
  const press = 0.5 - v * 0.035;
  detector.setOptions({ pressThreshold: press, releaseThreshold: press * 0.55 });
});
$('#thumb').addEventListener('input', (e) => { handle(detector.reset()); detector.setOptions({ useThumb: e.target.checked }); });
$('#volume').addEventListener('input', (e) => { if (synth) synth.volume = Number(e.target.value); });
$('#reverb').addEventListener('input', (e) => { if (synth) synth.reverbAmount = Number(e.target.value); });
$('#sustain').addEventListener('input', (e) => synth?.setSustain(e.target.checked));

function relayout() { handle(detector.reset()); layout = makeLayout(); }
function updateHint() {
  $('#hint').textContent = settings.mode === 'tap'
    ? 'Tap mode: hover your hands over the keys and push one finger down below the others to strike the key under it.'
    : 'Zone mode: any fingertip that enters a key plays it. Slide across keys for a glissando.';
}
updateHint();

// Computer keyboard fallback (also handy for testing audio): a w s e d f t g y h u j k o l p ;
const KBD = 'awsedftgyhujkolp;';
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); const s = $('#sustain'); s.checked = !s.checked; synth?.setSustain(s.checked); return; }
  const i = KBD.indexOf(e.key.toLowerCase());
  if (i < 0 || e.repeat || !synth) return;
  const midi = settings.startMidi + i;
  kbdHeld.add(midi);
  synth.noteOn(midi, 0.8, `kbd${midi}`);
  flashes.set(midi, performance.now());
});
window.addEventListener('keyup', (e) => {
  const i = KBD.indexOf(e.key.toLowerCase());
  if (i < 0) return;
  const midi = settings.startMidi + i;
  kbdHeld.delete(midi);
  synth?.noteOff(`kbd${midi}`);
});

// ---------- start ----------
$('#start').addEventListener('click', async () => {
  $('#start').disabled = true;
  try {
    synth = new PianoSynth();
    await synth.resume();
    synth.volume = Number($('#volume').value);
    synth.reverbAmount = Number($('#reverb').value);

    setStatus('Requesting camera…');
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false });
    video.srcObject = stream;
    await video.play();

    setStatus('Loading hand-tracking model…');
    tracker = await createHandTracker({ numHands: 2 });
    setStatus(`Ready (${tracker.delegate}). Show your hands!`, 'ok');
    $('#overlay').hidden = true;
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message || err}`, 'err');
    $('#start').disabled = false;
    if (synth) $('#overlay-msg').textContent = 'Camera or model failed to load. You can still play with your computer keyboard (A W S E D F …).';
  }
});

// ---------- loop ----------
let lastVideoTime = -1;
let fps = 0, lastFrame = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  if (tracker && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    try {
      hands = tracker.detect(video, now);
      const res = detector.update(hands, layout, now / 1000);
      handle(res.events);
      active = res.active;
    } catch (e) { console.error(e); }
    fps = fps * 0.9 + (1000 / Math.max(1, now - lastFrame)) * 0.1;
    lastFrame = now;
  }
  draw(now);
}
requestAnimationFrame(frame);

// ---------- rendering ----------
const CONNECTIONS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
const FINGER_COLORS = ['#f59e0b', '#ef4444', '#22c55e', '#3b82f6', '#a855f7'];

function resize() {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(r.width * dpr) || canvas.height !== Math.round(r.height * dpr)) {
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
  }
}

function draw(now) {
  resize();
  const W = canvas.width, H = canvas.height;
  g.clearRect(0, 0, W, H);

  // Mirrored camera image, "cover"-fit to the canvas so coordinates map 1:1.
  if (video.readyState >= 2) {
    g.save();
    g.translate(W, 0);
    g.scale(-1, 1);
    g.globalAlpha = 0.85;
    g.drawImage(video, 0, 0, W, H);
    g.restore();
  } else {
    g.fillStyle = '#111';
    g.fillRect(0, 0, W, H);
  }

  const pressed = new Set([...active.values()].map((k) => k.midi));
  for (const m of kbdHeld) pressed.add(m);

  const drawKey = (k) => {
    const x = k.x * W, y = k.y * H, w = k.w * W, h = k.h * H;
    const on = pressed.has(k.midi);
    const flash = Math.max(0, 1 - (now - (flashes.get(k.midi) ?? -1e9)) / 250);
    if (k.black) g.fillStyle = on ? 'rgba(250,204,21,0.95)' : `rgba(20,20,28,${0.82 + flash * 0.1})`;
    else g.fillStyle = on ? 'rgba(250,204,21,0.75)' : `rgba(255,255,255,${0.42 + flash * 0.3})`;
    roundRect(x + 1, y, w - 2, h, 6 * (window.devicePixelRatio || 1));
    g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.5)';
    g.lineWidth = 1;
    g.stroke();
    if (!k.black && k.name.startsWith('C') && k.name[1] !== '#') {
      g.fillStyle = 'rgba(0,0,0,0.6)';
      g.font = `${Math.max(10, w * 0.28)}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.fillText(k.name, x + w / 2, y + h - 10);
    }
  };
  layout.keys.filter((k) => !k.black).forEach(drawKey);
  layout.keys.filter((k) => k.black).forEach(drawKey);

  // Hands
  for (const hand of hands) {
    const lm = hand.landmarks;
    if (settings.showSkeleton) {
      g.strokeStyle = 'rgba(255,255,255,0.7)';
      g.lineWidth = 2 * (window.devicePixelRatio || 1);
      g.beginPath();
      for (const [a, b] of CONNECTIONS) { g.moveTo(lm[a].x * W, lm[a].y * H); g.lineTo(lm[b].x * W, lm[b].y * H); }
      g.stroke();
    }
    FINGERTIPS.forEach((tip, f) => {
      const id = `${hand.id}:${f}`;
      const st = detector.smoothed(id);
      const p = st ? { x: st.sx, y: st.sy } : lm[tip];
      const isOn = active.has(id);
      const disabled = settings.mode === 'tap' && f === 0 && !detector.config.useThumb;
      g.beginPath();
      g.arc(p.x * W, p.y * H, (isOn ? 12 : 7) * (window.devicePixelRatio || 1), 0, Math.PI * 2);
      g.fillStyle = disabled ? 'rgba(150,150,150,0.5)' : FINGER_COLORS[f];
      g.fill();
      if (isOn) { g.strokeStyle = '#fff'; g.lineWidth = 3; g.stroke(); }
    });
  }

  $('#fps').textContent = tracker ? `${hands.length} hand${hands.length === 1 ? '' : 's'} · ${fps.toFixed(0)} fps` : '';
}

function roundRect(x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x + w, y);
  g.lineTo(x + w, y + h - r);
  g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.closePath();
}

// Expose for debugging in the console.
window.pollo = { settings, detector, get synth() { return synth; }, get layout() { return layout; }, isBlack };
