import { buildLayout, hitTest, noteName, isBlack } from './piano.js';
import { createDetector, FINGERTIPS } from './detector.js';
import { PianoSynth } from './synth.js';
import { createHandTracker } from './hands.js';
import { loadSettings, saveSettings, defaultKeyboardRect, DEFAULTS } from './settings.js';
import { grabAt, dragRect, cursorFor } from './layout-editor.js';

const $ = (s) => document.querySelector(s);
const video = $('#video');
const canvas = $('#canvas');
const stage = $('#stage');
const stageWrap = $('#stageWrap');
const g = canvas.getContext('2d');

const settings = loadSettings();
let layout = makeLayout();
const detector = createDetector();
let synth = null;
let tracker = null;
let stream = null;
let hands = [];
let active = new Map();
let editing = false;
const flashes = new Map(); // midi -> time of last hit
const heldExtra = new Map(); // id -> midi, for touch and computer-keyboard notes
const pointers = new Map(); // pointerId -> drag or play state

function makeLayout() {
  const { x, y, w, h } = settings.kb;
  return buildLayout({ startMidi: settings.startMidi, whiteCount: settings.whiteCount, x, y, width: w, height: h });
}
function setStatus(t, cls = '') { const el = $('#status'); el.textContent = t; el.className = cls; }
const save = () => saveSettings(settings);

function noteOn(midi, velocity, id) {
  synth?.noteOn(midi, velocity, id);
  flashes.set(midi, performance.now());
}
function handle(events) {
  for (const e of events) e.type === 'on' ? noteOn(e.midi, e.velocity, e.finger) : synth?.noteOff(e.finger);
}

// ---------- settings UI ----------
function fillStartNotes() {
  const sel = $('#startMidi');
  for (let m = 24; m <= 96; m++) {
    if (isBlack(m)) continue;
    const o = document.createElement('option');
    o.value = m;
    o.textContent = noteName(m) + (m === 60 ? ' (middle C)' : '');
    sel.append(o);
  }
}
fillStartNotes();

const fmt = {
  sensitivity: (v) => v,
  whiteCount: (v) => `${v} (${(v / 7).toFixed(1).replace('.0', '')} oct)`,
  opacity: (v) => `${Math.round(v * 100)}%`,
  volume: (v) => `${Math.round(v * 100)}%`,
  reverb: (v) => `${Math.round((v / 0.6) * 100)}%`,
};

function readControl(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.type === 'range' || el.dataset.setting === 'startMidi') return Number(el.value);
  return el.value;
}
function writeControls() {
  for (const el of document.querySelectorAll('[data-setting]')) {
    const v = settings[el.dataset.setting];
    if (el.type === 'checkbox') el.checked = v;
    else el.value = String(v);
  }
  for (const out of document.querySelectorAll('output[data-for]')) {
    const k = out.dataset.for;
    out.textContent = fmt[k] ? fmt[k](settings[k]) : settings[k];
  }
}

function apply(key) {
  switch (key) {
    case 'mode':
    case 'useThumb':
    case 'sensitivity': {
      const press = 0.5 - settings.sensitivity * 0.035;
      handle(detector.reset());
      detector.setOptions({ mode: settings.mode, useThumb: settings.useThumb, pressThreshold: press, releaseThreshold: press * 0.55 });
      updateHint();
      break;
    }
    case 'startMidi':
    case 'whiteCount':
    case 'kb':
      handle(detector.reset());
      layout = makeLayout();
      break;
    case 'volume': if (synth) synth.volume = settings.volume; break;
    case 'reverb': if (synth) synth.reverbAmount = settings.reverb; break;
    case 'mirror':
    case 'flip': handle(detector.reset()); break;
    case 'camera': if (stream) startCamera().catch(cameraError); break;
    case 'accent': document.documentElement.style.setProperty('--accent', settings.accent); break;
  }
}
function applyAll() { ['mode', 'kb', 'volume', 'reverb', 'accent'].forEach(apply); }

for (const el of document.querySelectorAll('[data-setting]')) {
  el.addEventListener('input', () => {
    const key = el.dataset.setting;
    settings[key] = readControl(el);
    // Front cameras are usually mirrored, back cameras not.
    if (key === 'camera' && settings.camera.startsWith('facing:')) settings.mirror = settings.camera === 'facing:user';
    save();
    writeControls();
    apply(key);
  });
}

function updateHint() {
  $('#hint').textContent = settings.mode === 'tap'
    ? 'Tap: hold your hands over the keys and push one finger down below the others to play the key under it.'
    : 'Touch: any fingertip that moves into a key plays it. Slide across keys to play each in turn.';
}

$('#sustain').addEventListener('input', (e) => synth?.setSustain(e.target.checked));
$('#resetAll').addEventListener('click', () => {
  handle(detector.reset());
  const camera = settings.camera;
  Object.assign(settings, JSON.parse(JSON.stringify(DEFAULTS)), { camera });
  save(); writeControls(); applyAll();
});
const resetKeyboard = () => { settings.kb = defaultKeyboardRect(); save(); apply('kb'); };
$('#resetKb').addEventListener('click', resetKeyboard);
$('#resetKb2').addEventListener('click', resetKeyboard);

// ---------- panel, edit mode, fullscreen ----------
const narrow = window.matchMedia('(max-width: 900px)');
function setPanel(open) {
  document.body.classList.toggle('panel-open', open);
  $('#panelBtn').setAttribute('aria-expanded', String(open));
  requestAnimationFrame(fitStage);
}
setPanel(!narrow.matches);
$('#panelBtn').addEventListener('click', () => setPanel(!document.body.classList.contains('panel-open')));
$('#panelClose').addEventListener('click', () => setPanel(false));

function setEditing(on) {
  editing = on;
  $('#editBtn').setAttribute('aria-pressed', String(on));
  $('#editBanner').hidden = !on;
  document.body.classList.toggle('editing', on);
  canvas.style.cursor = 'default';
  handle(detector.reset());
  if (on && narrow.matches) setPanel(false);
}
$('#editBtn').addEventListener('click', () => setEditing(!editing));
$('#editBtn2').addEventListener('click', () => setEditing(true));
$('#doneEdit').addEventListener('click', () => setEditing(false));

const fsTarget = document.documentElement;
if (!fsTarget.requestFullscreen && !fsTarget.webkitRequestFullscreen) $('#fullBtn').hidden = true;
$('#fullBtn').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement || document.webkitFullscreenElement) await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else await (fsTarget.requestFullscreen || fsTarget.webkitRequestFullscreen).call(fsTarget);
  } catch { /* not allowed here */ }
});

// Keep the screen awake while playing.
async function keepAwake() {
  try { if (document.visibilityState === 'visible' && 'wakeLock' in navigator) await navigator.wakeLock.request('screen'); } catch { /* optional */ }
}
document.addEventListener('visibilitychange', () => { if (stream && document.visibilityState === 'visible') keepAwake(); });

// ---------- camera ----------
async function startCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  const base = { width: { ideal: 1280 }, height: { ideal: 720 } };
  const [kind, val] = [settings.camera.slice(0, settings.camera.indexOf(':')), settings.camera.slice(settings.camera.indexOf(':') + 1)];
  const constraints = kind === 'id' ? { ...base, deviceId: { exact: val } } : { ...base, facingMode: val };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
  } catch (err) {
    if (kind !== 'id' && err.name !== 'OverconstrainedError') throw err;
    stream = await navigator.mediaDevices.getUserMedia({ video: base, audio: false }); // any camera
  }
  video.srcObject = stream;
  await video.play();
  handle(detector.reset());
  fitStage();
  listCameras();
}

async function listCameras() {
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    const sel = $('#camera');
    sel.querySelectorAll('option[data-device]').forEach((o) => o.remove());
    devices.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = `id:${d.deviceId}`;
      o.dataset.device = '1';
      o.textContent = d.label || `Camera ${i + 1}`;
      sel.append(o);
    });
    sel.value = settings.camera;
    if (sel.value !== settings.camera) sel.value = 'facing:user';
    $('#switchCam').hidden = devices.length < 2;
  } catch { /* ignore */ }
}

$('#switchCam').addEventListener('click', () => {
  settings.camera = settings.camera === 'facing:environment' ? 'facing:user' : 'facing:environment';
  settings.mirror = settings.camera === 'facing:user';
  save(); writeControls();
  if (stream) startCamera().catch(cameraError);
});

function cameraError(err) {
  console.error(err);
  setStatus(`Camera unavailable: ${err.message || err.name}. You can still tap the keys on screen.`, 'err');
}

// ---------- start ----------
$('#start').addEventListener('click', async () => {
  $('#start').disabled = true;
  synth = new PianoSynth();
  await synth.resume();
  apply('volume'); apply('reverb');
  try {
    setStatus('Turning on the camera…');
    await startCamera();
    setStatus('Loading hand tracking…');
    tracker = await createHandTracker({ numHands: 2 });
    setStatus('Ready. Show your hands.', 'ok');
    keepAwake();
  } catch (err) {
    cameraError(err);
  }
  $('#overlay').hidden = true;
});

// ---------- stage sizing ----------
function fitStage() {
  const box = stageWrap.getBoundingClientRect();
  const ar = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
  let w = box.width, h = w / ar;
  if (h > box.height) { h = box.height; w = h * ar; }
  stage.style.width = `${Math.floor(w)}px`;
  stage.style.height = `${Math.floor(h)}px`;
}
new ResizeObserver(fitStage).observe(stageWrap);
video.addEventListener('loadedmetadata', fitStage);
video.addEventListener('resize', fitStage); // phone rotated

// ---------- view transform (mirror / upside down) ----------
function toView(p) {
  let x = settings.mirror ? 1 - p.x : p.x;
  let y = p.y;
  if (settings.flip) { x = 1 - x; y = 1 - y; }
  return { x, y };
}

// ---------- touch / mouse ----------
function toNorm(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, r };
}
function grabTolerance(r) {
  const px = matchMedia('(pointer: coarse)').matches ? 30 : 16;
  return { x: px / r.width, y: px / r.height };
}

canvas.addEventListener('pointerdown', (e) => {
  const p = toNorm(e);
  if (editing) {
    const mode = grabAt(settings.kb, p.x, p.y, grabTolerance(p.r));
    if (!mode) return;
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { kind: 'edit', mode, start: { ...settings.kb }, sx: p.x, sy: p.y });
    return;
  }
  const k = hitTest(layout, p.x, p.y);
  if (!k || !synth) return;
  canvas.setPointerCapture(e.pointerId);
  const id = `ptr${e.pointerId}`;
  noteOn(k.midi, 0.8, id);
  heldExtra.set(id, k.midi);
  pointers.set(e.pointerId, { kind: 'play', id, midi: k.midi });
});

canvas.addEventListener('pointermove', (e) => {
  const p = toNorm(e);
  const st = pointers.get(e.pointerId);
  if (!st) {
    if (editing) canvas.style.cursor = cursorFor(grabAt(settings.kb, p.x, p.y, grabTolerance(p.r)));
    return;
  }
  if (st.kind === 'edit') {
    settings.kb = dragRect(st.start, st.mode, p.x - st.sx, p.y - st.sy);
    layout = makeLayout();
  } else {
    const k = hitTest(layout, p.x, p.y);
    if (k?.midi !== st.midi) {
      synth?.noteOff(st.id);
      heldExtra.delete(st.id);
      st.midi = k?.midi;
      if (k) { noteOn(k.midi, 0.7, st.id); heldExtra.set(st.id, k.midi); }
    }
  }
});

function endPointer(e) {
  const st = pointers.get(e.pointerId);
  if (!st) return;
  pointers.delete(e.pointerId);
  if (st.kind === 'edit') { save(); apply('kb'); }
  else { synth?.noteOff(st.id); heldExtra.delete(st.id); }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

// Computer keyboard: a w s e d f t g y h u j k o l p ;  — Space toggles sustain.
const KBD = 'awsedftgyhujkolp;';
window.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || (tag === 'BUTTON' && e.code === 'Space')) return;
  if (e.code === 'Space') { e.preventDefault(); const s = $('#sustain'); s.checked = !s.checked; synth?.setSustain(s.checked); return; }
  if (e.key === 'Escape' && editing) { setEditing(false); return; }
  const i = KBD.indexOf(e.key.toLowerCase());
  if (i < 0 || e.repeat || !synth) return;
  const midi = settings.startMidi + i;
  noteOn(midi, 0.8, `kbd${midi}`);
  heldExtra.set(`kbd${midi}`, midi);
});
window.addEventListener('keyup', (e) => {
  const i = KBD.indexOf(e.key.toLowerCase());
  if (i < 0) return;
  const midi = settings.startMidi + i;
  synth?.noteOff(`kbd${midi}`);
  heldExtra.delete(`kbd${midi}`);
});

// ---------- loop ----------
let lastVideoTime = -1;
let fps = 0, lastFrame = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  if (tracker && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    try {
      hands = tracker.detect(video, now).map((h) => ({ id: h.id, landmarks: h.landmarks.map(toView) }));
      if (!editing) {
        const res = detector.update(hands, layout, now / 1000);
        handle(res.events);
        active = res.active;
      } else active = new Map();
    } catch (e) { console.error(e); }
    fps = fps * 0.9 + (1000 / Math.max(1, now - lastFrame)) * 0.1;
    lastFrame = now;
  }
  draw(now);
}

// ---------- rendering ----------
const CONNECTIONS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
const FINGER_COLORS = ['#f59e0b', '#ef4444', '#22c55e', '#3b82f6', '#a855f7'];

function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function resizeCanvas() {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  return dpr;
}

function draw(now) {
  const dpr = resizeCanvas();
  const W = canvas.width, H = canvas.height;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, W, H);

  if (video.readyState >= 2) {
    const sx = (settings.mirror ? -1 : 1) * (settings.flip ? -1 : 1);
    const sy = settings.flip ? -1 : 1;
    g.setTransform(sx, 0, 0, sy, sx < 0 ? W : 0, sy < 0 ? H : 0);
    g.globalAlpha = 0.85;
    g.drawImage(video, 0, 0, W, H);
    g.globalAlpha = 1;
    g.setTransform(1, 0, 0, 1, 0, 0);
  } else {
    g.fillStyle = '#111';
    g.fillRect(0, 0, W, H);
  }

  const pressed = new Set([...active.values()].map((k) => k.midi));
  for (const m of heldExtra.values()) pressed.add(m);
  const op = settings.opacity;

  const drawKey = (k) => {
    const x = k.x * W, y = k.y * H, w = k.w * W, h = k.h * H;
    const on = pressed.has(k.midi);
    const flash = Math.max(0, 1 - (now - (flashes.get(k.midi) ?? -1e9)) / 250);
    if (on) g.fillStyle = hexToRgba(settings.accent, k.black ? 0.95 : Math.max(0.7, op));
    else if (k.black) g.fillStyle = `rgba(20,20,28,${Math.min(1, op + 0.3 + flash * 0.1)})`;
    else g.fillStyle = `rgba(255,255,255,${Math.min(1, op * 0.8 + flash * 0.3)})`;
    roundRect(x + 1, y, w - 2, h, Math.min(6 * dpr, w / 4));
    g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.5)';
    g.lineWidth = 1;
    g.stroke();
    const showLabel = settings.labels === 'all' || (settings.labels === 'c' && k.name[0] === 'C' && !k.black);
    if (showLabel) {
      const size = Math.max(9 * dpr, Math.min(w * (k.black ? 0.4 : 0.3), 18 * dpr));
      g.font = `${size}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.fillStyle = k.black ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.65)';
      g.fillText(k.black ? k.name.replace(/\d/, '') : k.name, x + w / 2, y + h - Math.min(10 * dpr, h * 0.08));
    }
  };
  layout.keys.filter((k) => !k.black).forEach(drawKey);
  layout.keys.filter((k) => k.black).forEach(drawKey);

  if (editing) drawEditFrame(W, H, dpr);

  for (const hand of hands) {
    const lm = hand.landmarks;
    if (settings.skeleton) {
      g.strokeStyle = 'rgba(255,255,255,0.7)';
      g.lineWidth = 2 * dpr;
      g.beginPath();
      for (const [a, b] of CONNECTIONS) { g.moveTo(lm[a].x * W, lm[a].y * H); g.lineTo(lm[b].x * W, lm[b].y * H); }
      g.stroke();
    }
    FINGERTIPS.forEach((tip, f) => {
      const id = `${hand.id}:${f}`;
      const st = detector.smoothed(id);
      const p = st ? { x: st.sx, y: st.sy } : lm[tip];
      const isOn = active.has(id);
      const disabled = settings.mode === 'tap' && f === 0 && !settings.useThumb;
      g.beginPath();
      g.arc(p.x * W, p.y * H, (isOn ? 12 : 7) * dpr, 0, Math.PI * 2);
      g.fillStyle = disabled ? 'rgba(150,150,150,0.5)' : FINGER_COLORS[f];
      g.fill();
      if (isOn) { g.strokeStyle = '#fff'; g.lineWidth = 3 * dpr; g.stroke(); }
    });
  }

  $('#fps').textContent = tracker ? `${hands.length} hand${hands.length === 1 ? '' : 's'} · ${fps.toFixed(0)} fps` : '';
}

function drawEditFrame(W, H, dpr) {
  const { x, y, w, h } = settings.kb;
  const X = x * W, Y = y * H, RW = w * W, RH = h * H;
  g.save();
  g.setLineDash([8 * dpr, 6 * dpr]);
  g.strokeStyle = settings.accent;
  g.lineWidth = 2 * dpr;
  g.strokeRect(X, Y, RW, RH);
  g.setLineDash([]);
  const r = (matchMedia('(pointer: coarse)').matches ? 11 : 8) * dpr;
  const pts = [[X, Y], [X + RW / 2, Y], [X + RW, Y], [X + RW, Y + RH / 2], [X + RW, Y + RH], [X + RW / 2, Y + RH], [X, Y + RH], [X, Y + RH / 2]];
  for (const [px, py] of pts) {
    g.beginPath();
    g.arc(px, py, r, 0, Math.PI * 2);
    g.fillStyle = settings.accent;
    g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.6)';
    g.lineWidth = 1.5 * dpr;
    g.stroke();
  }
  g.restore();
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

// ---------- boot ----------
writeControls();
applyAll();
fitStage();
requestAnimationFrame(frame);

// Exposed for debugging in the browser console.
window.pollo = { settings, detector, get synth() { return synth; }, get layout() { return layout; } };
