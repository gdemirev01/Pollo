import { buildLayout, hitTest, noteName, isBlack } from './piano.js';
import { createDetector, FINGERTIPS } from './detector.js';
import { PianoSynth } from './synth.js';
import { createHandTracker } from './hands.js';
import { loadSettings, saveSettings, defaultQuad, DEFAULTS } from './settings.js';
import { grabAt, dragQuad, cursorFor, rectQuad, boundsOf, shiftQuad, isValidQuad } from './layout-editor.js';
import { placement } from './homography.js';
import { createSteadiness, snapLayout, fingerSpacing } from './snap.js';
import { createSurfaceTracker } from './surface-tracker.js';
import { createHandSmoother } from './filters.js';
import { createCalibrator } from './calibrate.js';
import { poseFromQuad, keyBoxes, keyboardSize, boxFaces, WHITE_HEIGHT_CM, BLACK_EXTRA_CM } from './ar.js';
import { apply as applyH } from './homography.js';

const $ = (s) => document.querySelector(s);
const video = $('#video');
const canvas = $('#canvas');
const stage = $('#stage');
const stageWrap = $('#stageWrap');
let g = canvas.getContext('2d'); // reassigned briefly while drawing the 3D piano layer

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

// Keys live in a unit square (u across the keys, v from the far end to the
// player's side); `place` maps that square onto the keyboard's four corners on
// screen, so the keyboard can lie on the table in perspective.
function makeLayout() {
  return buildLayout({ startMidi: settings.startMidi, whiteCount: settings.whiteCount, x: 0, y: 0, width: 1, height: 1 });
}
// How the table has moved in the picture since the keyboard was placed
// (a perspective transform in pixels of the small tracking image), or null.
let tableMotion = null;
let lastGoodQuad = null;
function effQuad() {
  if (!tableMotion) return settings.quad;
  const { H, w, h } = tableMotion;
  const q = settings.quad.map(([x, y]) => { const p = applyH(H, x * w, y * h); return [p.x / w, p.y / h]; });
  if (plausible(q)) lastGoodQuad = q;
  return lastGoodQuad || settings.quad;
}
// Safety net: never let table following throw the keyboard somewhere it can't be
// (off screen, or suddenly much bigger or smaller than where it was placed).
function plausible(q) {
  if (!isValidQuad(q)) return false;
  const area = (Q) => Math.abs(Q.reduce((s, p, i) => { const n = Q[(i + 1) % 4]; return s + p[0] * n[1] - n[0] * p[1]; }, 0)) / 2;
  const ratio = area(q) / Math.max(1e-6, area(settings.quad));
  const cx = q.reduce((s, p) => s + p[0], 0) / 4, cy = q.reduce((s, p) => s + p[1], 0) / 4;
  return ratio > 0.4 && ratio < 2.5 && cx > -0.05 && cx < 1.05 && cy > -0.05 && cy < 1.05;
}
let place = placement(effQuad());
const updatePlacement = () => { place = placement(effQuad()); };
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
  keyHeight: (v) => `${v.toFixed(1)}×`,
  fov: (v) => `${v}°`,
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
      const v = settings.sensitivity; // 1..10, higher = smaller, gentler taps count
      handle(detector.reset());
      detector.setOptions({
        mode: settings.mode, useThumb: settings.useThumb, scale: 1.6 - v * 0.12,
        calibration: settings.calibration?.[settings.mode] || null,
      });
      showCalState();
      updateHint();
      break;
    }
    case 'startMidi':
    case 'whiteCount':
      handle(detector.reset());
      layout = makeLayout();
      break;
    case 'quad':
      handle(detector.reset());
      tableMotion = null; lastGoodQuad = null;
      updatePlacement();
      needReference = true;
      break;
    case 'anchor':
      tableMotion = null; lastGoodQuad = null;
      updatePlacement();
      surface.clear();
      needReference = settings.anchor;
      break;
    case 'volume': if (synth) synth.volume = settings.volume; break;
    case 'reverb': if (synth) synth.reverbAmount = settings.reverb; break;
    case 'mirror':
    case 'flip': handle(detector.reset()); needReference = true; break;
    case 'camera': if (stream) startCamera().then(autoSnapAgain).catch(cameraError); break;
    case 'accent': document.documentElement.style.setProperty('--accent', settings.accent); break;
  }
}
function applyAll() { ['mode', 'startMidi', 'quad', 'volume', 'reverb', 'accent'].forEach(apply); }

for (const el of document.querySelectorAll('[data-setting]')) {
  el.addEventListener('input', () => {
    const key = el.dataset.setting;
    settings[key] = readControl(el);
    // Front cameras are usually mirrored, back cameras not.
    if (key === 'camera' && settings.camera.startsWith('facing:')) settings.mirror = settings.camera === 'facing:user';
    // Table mode is for a camera above the hands: use the back camera, unmirrored.
    if (key === 'mode' && settings.mode === 'surface' && settings.camera === 'facing:user') {
      settings.camera = 'facing:environment';
      settings.mirror = false;
      apply('camera');
    }
    save();
    writeControls();
    apply(key);
  });
}

function updateHint() {
  $('#hint').textContent = {
    tap: 'Camera in front of you. Rest your fingers on the table, lift one and tap it down: the note plays when it hits the table, on the key under that fingertip, and stops when you lift it.',
    zone: 'Touch: any fingertip that moves into a key plays it. Slide across keys to play each in turn.',
    surface: 'Camera above, looking down. Lift a finger and tap the table: the note plays when it lands, on the key under that fingertip, and stops when you lift it.',
  }[settings.mode];
}

$('#sustain').addEventListener('input', (e) => synth?.setSustain(e.target.checked));
$('#resetAll').addEventListener('click', () => {
  handle(detector.reset());
  const camera = settings.camera;
  Object.assign(settings, JSON.parse(JSON.stringify(DEFAULTS)), { camera });
  save(); writeControls(); applyAll();
});
function setQuad(q) { settings.quad = q; save(); apply('quad'); }
const resetKeyboard = () => setQuad(defaultQuad());
const squareUp = () => setQuad(rectQuad(boundsOf(settings.quad)));
$('#resetKb').addEventListener('click', resetKeyboard);
$('#resetKb2').addEventListener('click', resetKeyboard);
$('#squareKb').addEventListener('click', squareUp);
$('#squareKb2').addEventListener('click', squareUp);

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
  if (on) {
    if (snapping) endSnap();
    // Edit where the keyboard is right now (including any table-following shift).
    settings.quad = effQuad();
    tableMotion = null; lastGoodQuad = null;
    updatePlacement();
  } else if (editing) {
    save();
    apply('quad');
  }
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

// ---------- snap to hands ----------
let snapping = null; // { steady, started, auto }
// auto: started by the app when the camera comes on; waits for hands as long as
// it takes and can be skipped. Otherwise started by the Snap button.
function startSnap({ auto = false } = {}) {
  if (!tracker) { setStatus('Start the camera first, then snap the keyboard to your hands.', 'err'); return; }
  if (editing) setEditing(false);
  handle(detector.reset());
  snapping = { steady: createSteadiness({ hold: 1.2, maxMove: auto ? 0.035 : 0.025 }), started: performance.now(), auto };
  $('#snapBanner').hidden = false;
  document.body.classList.add('editing');
  $('#snapText').textContent = auto
    ? 'Show your hands where you want to play and hold still. The keyboard will appear under them.'
    : 'Rest your hands where you want to play, and hold still.';
  $('#snapCancel').textContent = auto ? 'Skip' : 'Cancel';
  $('#snapBar').style.width = '0%';
  if (narrow.matches) setPanel(false);
}
function endSnap(message, cls = 'ok') {
  snapping = null;
  $('#snapBanner').hidden = true;
  document.body.classList.remove('editing');
  if (message) setStatus(message, cls);
}
function snapStep(now) {
  const tips = {}, list = [], wrists = [];
  for (const hand of hands) {
    wrists.push(hand.landmarks[0]);
    for (let f = 1; f < 5; f++) { // index..pinky
      const p = hand.landmarks[FINGERTIPS[f]];
      tips[`${hand.id}:${f}`] = p;
      list.push(p);
    }
  }
  const progress = snapping.steady.add(now / 1000, tips);
  $('#snapBar').style.width = `${Math.round(progress * 100)}%`;
  $('#snapText').textContent = !hands.length
    ? (snapping.auto ? 'Show your hands where you want to play. The keyboard will appear under them.' : 'No hands in view yet. Hold your hands in front of the camera.')
    : progress < 1 ? 'Found your hands. Hold still…' : 'Placing the keyboard…';
  if (progress >= 1) {
    const aspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
    // Camera above the table: face the keys toward the wrists. Camera in front: keep them upright.
    // Finger-sized keys: each white key as wide as the gap between neighbouring fingertips.
    const perHand = hands.map((hand) => [1, 2, 3, 4].map((f) => hand.landmarks[FINGERTIPS[f]]));
    const keyWidth = fingerSpacing(perHand, aspect);
    const r = snapLayout(list, wrists, aspect, {
      orient: settings.mode === 'surface' ? 'auto' : 'upright',
      keyWidth, keyCount: settings.whiteCount,
    });
    if (r && isValidQuad(r.quad)) {
      let note = '';
      if (r.keyCount !== settings.whiteCount) {
        note = ` Only ${r.keyCount} finger-sized white keys fit on screen, so the keyboard has ${r.keyCount} now.`;
        settings.whiteCount = r.keyCount;
        writeControls();
        apply('whiteCount');
      }
      setQuad(r.quad);
      endSnap(`Keyboard placed under your hands, one key per finger.${note} Use Move keys to adjust it.`);
    }
    else endSnap('Could not fit the keyboard there. Try with your hands a bit further apart.', 'err');
  } else if (!snapping.auto && now - snapping.started > 20000) {
    endSnap('Could not see your hands holding still. Try again with good light.', 'err');
  }
}
$('#snapBtn').addEventListener('click', startSnap);
$('#snapBtn2').addEventListener('click', startSnap);
$('#snapCancel').addEventListener('click', () => endSnap());

// ---------- tap calibration ----------
const CAL_SECONDS = 8;
let calibrating = null; // { cal, seen, last }
const FINGER_LABELS = ['thumb', 'index', 'middle', 'ring', 'pinky'];

function showCalState() {
  const el = $('#calState');
  if (settings.mode === 'zone') { el.textContent = 'Touch mode needs no calibration.'; return; }
  el.textContent = settings.calibration?.[settings.mode]
    ? 'Taps are calibrated for this camera setup.'
    : 'Not calibrated. If taps don\'t register well, calibrate: it learns how your taps look from this camera angle.';
}

function startCalibration() {
  if (!tracker) { setStatus('Start the camera first, then calibrate your taps.', 'err'); return; }
  if (settings.mode === 'zone') { setStatus('Touch mode needs no calibration. Pick a Tap the table mode first.', 'err'); return; }
  if (editing) setEditing(false);
  if (snapping) endSnap();
  handle(detector.reset());
  calibrating = { cal: createCalibrator(), seen: 0, last: null };
  $('#calBanner').hidden = false;
  document.body.classList.add('editing');
  $('#calBar').style.width = '0%';
  $('#calText').textContent = 'Rest your hands on the table, then tap each finger a few times, one at a time, like slow notes.';
  if (narrow.matches) setPanel(false);
}
function endCalibration(message, cls = 'ok') {
  calibrating = null;
  $('#calBanner').hidden = true;
  document.body.classList.remove('editing');
  if (message) setStatus(message, cls);
}
function calibrationStep(now) {
  const t = now / 1000;
  if (hands.length) {
    calibrating.cal.add(hands);
    if (calibrating.last !== null) calibrating.seen += Math.min(0.2, t - calibrating.last);
  }
  calibrating.last = t;
  const p = Math.min(1, calibrating.seen / CAL_SECONDS);
  $('#calBar').style.width = `${Math.round(p * 100)}%`;
  $('#calText').textContent = hands.length
    ? `Tap each finger a few times, one at a time… ${Math.ceil(CAL_SECONDS - calibrating.seen)} s`
    : 'Show your hands on the table to continue.';
  if (p < 1) return;
  const result = calibrating.cal.result();
  if (!result) {
    endCalibration(hands.length || calibrating?.seen
      ? "Didn't see clear taps. Calibrate again and lift each finger a little higher before tapping it down."
      : "Calibration didn't get enough of your hands. Try again with your hands in view.", 'err');
    return;
  }
  settings.calibration = { ...settings.calibration, [settings.mode]: result };
  save();
  apply('mode');
  const first = Object.values(result.hands)[0];
  const counts = first.taps.slice(1).map((n, i) => `${FINGER_LABELS[i + 1]} ${n}`).join(', ');
  endCalibration(`Taps calibrated. Taps seen: ${counts}. If a finger shows 0, calibrate again and tap that one too.`);
}
$('#calBtn').addEventListener('click', startCalibration);
$('#calBtn2').addEventListener('click', startCalibration);
$('#calCancel').addEventListener('click', () => endCalibration());
$('#calClear').addEventListener('click', () => {
  const c = { ...settings.calibration }; delete c[settings.mode];
  settings.calibration = c; save(); apply('mode');
  setStatus('Calibration cleared for this mode.', 'ok');
});

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
  needReference = true;
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
  if (stream) startCamera().then(autoSnapAgain).catch(cameraError);
});
// A different camera sees the table differently: place the keyboard again.
function autoSnapAgain() { if (settings.autoSnap && tracker && !editing) startSnap({ auto: true }); }

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
    if (settings.autoSnap) startSnap({ auto: true });
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
  return { x, y, z: p.z };
}

// ---------- touch / mouse ----------
function keyAt(x, y) {
  const l = place.toLocal(x, y);
  return hitTest(layout, l.x, l.y);
}
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
    const mode = grabAt(settings.quad, p.x, p.y, grabTolerance(p.r));
    if (!mode) return;
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { kind: 'edit', mode, start: settings.quad.map((q) => [...q]), sx: p.x, sy: p.y });
    return;
  }
  const k = keyAt(p.x, p.y);
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
    if (editing) canvas.style.cursor = cursorFor(grabAt(settings.quad, p.x, p.y, grabTolerance(p.r)), settings.quad);
    return;
  }
  if (st.kind === 'edit') {
    const q = dragQuad(st.start, st.mode, p.x - st.sx, p.y - st.sy);
    if (q) { settings.quad = q; updatePlacement(); }
  } else {
    const k = keyAt(p.x, p.y);
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
  if (st.kind === 'edit') save();
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

// ---------- keep the keyboard on the table if the phone moves ----------
const surface = createSurfaceTracker();
let needReference = true;
let follow = { ok: false, lastGood: 0 };
const work = document.createElement('canvas');
const wctx = work.getContext('2d', { willReadFrequently: true });

function grabTable() {
  const w = 320;
  const h = Math.max(4, Math.round((w * video.videoHeight) / video.videoWidth) & ~1);
  if (work.width !== w || work.height !== h) { work.width = w; work.height = h; }
  const sx = (settings.mirror ? -1 : 1) * (settings.flip ? -1 : 1), sy = settings.flip ? -1 : 1;
  wctx.setTransform(sx, 0, 0, sy, sx < 0 ? w : 0, sy < 0 ? h : 0);
  wctx.drawImage(video, 0, 0, w, h);
  const d = wctx.getImageData(0, 0, w, h).data;
  const gray = new Float32Array(w * h);
  for (let i = 0; i < gray.length; i++) gray[i] = 0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2];
  // Hands move on their own: leave them out.
  const mask = new Uint8Array(w * h);
  for (const hand of hands) {
    const xs = hand.landmarks.map((p) => p.x), ys = hand.landmarks.map((p) => p.y);
    let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const px = (x1 - x0) * 0.3 + 0.03, py = (y1 - y0) * 0.3 + 0.03;
    x0 = Math.max(0, Math.floor((x0 - px) * w)); x1 = Math.min(w, Math.ceil((x1 + px) * w));
    y0 = Math.max(0, Math.floor((y0 - py) * h)); y1 = Math.min(h, Math.ceil((y1 + py) * h));
    for (let y = y0; y < y1; y++) mask.fill(1, y * w + x0, y * w + x1);
    // The forearm: a wide band from the wrist away from the fingers, to the picture's edge.
    const wr = hand.landmarks[0], mc = hand.landmarks[9];
    const ax = wr.x * w, ay = wr.y * h;
    let dx = (wr.x - mc.x) * w, dy = (wr.y - mc.y) * h;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const half = len * 0.8, reach = (w + h) * 2;
    const bx = ax + dx * reach, by = ay + dy * reach;
    const minX = Math.max(0, Math.floor(Math.min(ax, bx) - half)), maxX = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + half));
    const minY = Math.max(0, Math.floor(Math.min(ay, by) - half)), maxY = Math.min(h - 1, Math.ceil(Math.max(ay, by) + half));
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const tAlong = (x - ax) * dx + (y - ay) * dy;
      if (tAlong < -half) continue;
      const perp = Math.abs((x - ax) * dy - (y - ay) * dx);
      if (perp <= half) mask[y * w + x] = 1;
    }
  }
  return { gray, mask, w, h };
}

let followSkip = 0;
function followTable(now) {
  if (!settings.anchor || video.readyState < 2 || !video.videoWidth) return;
  // On a slow phone, follow the table every other frame to leave time for hand tracking.
  if (!needReference && fps < 22 && followSkip++ % 2) return;
  const { gray, mask, w, h } = grabTable();
  if (needReference) {
    surface.setReference(gray, mask, w, h);
    needReference = false;
    tableMotion = null; lastGoodQuad = null;
    follow = { ok: surface.features >= 12, lastGood: now };
    return;
  }
  const r = surface.track(gray, mask, w, h);
  if (r.ok) {
    tableMotion = { H: r.H, w, h };
    updatePlacement();
    follow.lastGood = now;
    follow.ok = true;
  } else if (now - follow.lastGood > 1000) {
    follow.ok = false;
  }
}

// ---------- loop ----------
const smoother = createHandSmoother();
let lastVideoTime = -1;
let fps = 0, lastFrame = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  if (tracker && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    try {
      hands = smoother.smooth(tracker.detect(video, now).map((h) => ({ id: h.id, landmarks: h.landmarks.map(toView) })), now / 1000);
      if (calibrating) { calibrationStep(now); active = new Map(); }
      else if (snapping) { snapStep(now); active = new Map(); }
      else if (!editing) {
        followTable(now);
        const res = detector.update(hands, layout, now / 1000, place.toLocal);
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
    g.globalAlpha = settings.look3d ? 1 : 0.85;
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

  const S = (u, v) => { const p = place.toScreen(u, v); return [p.x * W, p.y * H]; };
  const drawKey = (k) => {
    const on = pressed.has(k.midi);
    const flash = Math.max(0, 1 - (now - (flashes.get(k.midi) ?? -1e9)) / 250);
    if (on) g.fillStyle = hexToRgba(settings.accent, k.black ? 0.95 : Math.max(0.7, op));
    else if (k.black) g.fillStyle = `rgba(20,20,28,${Math.min(1, op + 0.3 + flash * 0.1)})`;
    else g.fillStyle = `rgba(255,255,255,${Math.min(1, op * 0.8 + flash * 0.3)})`;
    const inset = k.w * 0.04;
    const pts = [S(k.x + inset, k.y), S(k.x + k.w - inset, k.y), S(k.x + k.w - inset, k.y + k.h), S(k.x + inset, k.y + k.h)];
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.5)';
    g.lineWidth = 1;
    g.stroke();
    const showLabel = settings.labels === 'all' || (settings.labels === 'c' && k.name[0] === 'C' && !k.black);
    if (showLabel) {
      const [lx, ly] = S(k.x + k.w / 2, k.y + k.h * 0.88);
      const [ax] = S(k.x, k.y + k.h * 0.88), [bx] = S(k.x + k.w, k.y + k.h * 0.88);
      const w = Math.abs(bx - ax);
      const size = Math.max(9 * dpr, Math.min(w * (k.black ? 0.4 : 0.3), 18 * dpr));
      g.font = `${size}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.fillStyle = k.black ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.65)';
      g.fillText(k.black ? k.name.replace(/\d/, '') : k.name, lx, ly);
    }
  };
  let drew3d = false;
  if (settings.look3d) {
    try { drew3d = drawKeys3D(now, W, H, dpr, pressed); } catch (e) { reportDrawError('3D keys', e); }
  }
  if (!drew3d) {
    layout.keys.filter((k) => !k.black).forEach(drawKey);
    layout.keys.filter((k) => k.black).forEach(drawKey);
  }
  if (settings.occlusion && drew3d && hands.length && video.readyState >= 2) {
    try { drawHandsOver(W, H); } catch (e) { reportDrawError('hands in front of keys', e); }
  }

  if (editing) drawEditFrame(W, H, dpr);
  else if (settings.anchor && tracker && !snapping && !settings.tracking) drawFollowBadge(W, H, dpr);

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
      const disabled = st?.state === 'off';
      g.beginPath();
      g.arc(p.x * W, p.y * H, (isOn ? 12 : 7) * dpr, 0, Math.PI * 2);
      g.fillStyle = disabled ? 'rgba(150,150,150,0.5)' : FINGER_COLORS[f];
      g.fill();
      if (isOn) { g.strokeStyle = '#fff'; g.lineWidth = 3 * dpr; g.stroke(); }
      if (st?.state === 'armed') { // lifted, ready to strike
        g.beginPath();
        g.arc(p.x * W, p.y * H, 15 * dpr, 0, Math.PI * 2);
        g.strokeStyle = '#fbbf24'; g.lineWidth = 2.5 * dpr; g.stroke();
      }
    });
  }

  if (settings.tracking && tracker && !editing) drawTracking(now, W, H, dpr);

  $('#fps').textContent = tracker ? `${hands.length} hand${hands.length === 1 ? '' : 's'} · ${fps.toFixed(0)} fps` : '';
}

// If drawing fails on some device, fall back (flat keys / no hand overlay) and say
// so once in the status line, so the piano never vanishes silently.
const drawErrors = new Set();
function reportDrawError(what, e) {
  console.error(e);
  if (drawErrors.has(what)) return;
  drawErrors.add(what);
  setStatus(`Couldn't draw ${what} on this device (${e?.message || e}). Showing a simpler view.`, 'err');
}

// ---------- 3D keys on the table ----------
const KEY_COLORS = {
  white: { top: '#f3f0e8', front: '#c6c0b3', left: '#d9d4ca', right: '#d9d4ca', back: '#b8b2a6' },
  black: { top: '#30303a', front: '#121216', left: '#1b1b21', right: '#1b1b21', back: '#101014' },
  case: { top: '#2a2a33', front: '#1a1a20', left: '#16161b', right: '#16161b', back: '#121217' },
};
function shade(hex, k) { // k < 0 darker, > 0 lighter
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(k < 0 ? v * (1 + k) : v + (255 - v) * k));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
function polyPath(pts) { g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath(); }

// The piano is drawn solid on its own layer, then laid over the video with the
// chosen opacity, so keys never show through each other.
const pianoLayer = document.createElement('canvas');
function drawKeys3D(now, W, H, dpr, pressed) {
  const size = keyboardSize(settings.whiteCount);
  const pose = poseFromQuad(effQuad().map(([x, y]) => [x * W, y * H]), W, H, settings.fov, size);
  if (!pose) return false;
  if (pianoLayer.width !== W || pianoLayer.height !== H) { pianoLayer.width = W; pianoLayer.height = H; }
  const main = g;
  g = pianoLayer.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, W, H);
  try { drawPiano(now, dpr, pose, size, pressed); } finally { g = main; }
  g.save();
  g.globalAlpha = Math.min(1, Math.max(0.3, settings.opacity * 1.8));
  g.drawImage(pianoLayer, 0, 0);
  g.restore();
  return true;
}
function drawPiano(now, dpr, pose, size, pressed) {
  const hs = settings.keyHeight;
  const P = (X, Y, Z) => pose.project(X, Y, Z);
  g.save();

  // Soft shadow on the table under the whole keyboard.
  const caseH = (WHITE_HEIGHT_CM + BLACK_EXTRA_CM + 0.8) * hs;
  const foot = [P(-0.8, -3.4, 0), P(size.w + 0.8, -3.4, 0), P(size.w + 0.8, size.d + 0.6, 0), P(-0.8, size.d + 0.6, 0)];
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = 22 * dpr; g.shadowOffsetY = 6 * dpr;
  polyPath(foot); g.fillStyle = 'rgba(0,0,0,0.38)'; g.fill();
  g.restore();

  // Case: a back panel behind the keys and thin cheeks at both ends.
  const caseBoxes = [
    boxFaces(pose, -0.8, size.w + 0.8, -3.4, 0, 0, caseH),
    boxFaces(pose, -0.8, 0, 0, size.d * 0.98, 0, WHITE_HEIGHT_CM * hs + 0.4 * hs),
    boxFaces(pose, size.w, size.w + 0.8, 0, size.d * 0.98, 0, WHITE_HEIGHT_CM * hs + 0.4 * hs),
  ];
  for (const faces of caseBoxes) for (const fc of faces) { polyPath(fc.pts); g.fillStyle = KEY_COLORS.case[fc.name]; g.fill(); }

  const accentDark = shade(settings.accent, -0.35);
  for (const b of keyBoxes(pose, layout, size, pressed, hs)) {
    const flash = Math.max(0, 1 - (now - (flashes.get(b.key.midi) ?? -1e9)) / 250);
    const pal = KEY_COLORS[b.key.black ? 'black' : 'white'];
    for (const fc of b.faces) {
      polyPath(fc.pts);
      if (b.down) g.fillStyle = fc.name === 'top' ? settings.accent : accentDark;
      else g.fillStyle = flash > 0 && fc.name === 'top' ? shade(pal.top, b.key.black ? 0.25 * flash : -0.08 * flash) : pal[fc.name];
      g.fill();
      g.strokeStyle = b.key.black ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0.18)';
      g.lineWidth = 1;
      g.stroke();
    }
    const showLabel = settings.labels === 'all' || (settings.labels === 'c' && b.key.name[0] === 'C' && !b.key.black);
    if (showLabel) {
      const t = b.faces.find((fc) => fc.name === 'top').pts;
      const near = { x: (t[2].x + t[3].x) / 2, y: (t[2].y + t[3].y) / 2 }, far = { x: (t[0].x + t[1].x) / 2, y: (t[0].y + t[1].y) / 2 };
      const at = { x: near.x + (far.x - near.x) * 0.14, y: near.y + (far.y - near.y) * 0.14 };
      const w = Math.hypot(t[2].x - t[3].x, t[2].y - t[3].y);
      g.font = `600 ${Math.max(8 * dpr, Math.min(w * 0.42, 16 * dpr))}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.fillStyle = b.key.black ? 'rgba(255,255,255,0.75)' : 'rgba(40,36,30,0.6)';
      g.fillText(b.key.black ? b.key.name.replace(/\d/, '') : b.key.name, at.x, at.y);
    }
  }
  g.restore();
}

// Draw the hands (and forearms) from the camera picture over the keys, so fingers
// sit on top of the keys instead of behind them. Done with a plain clipping path,
// which every browser draws the same way (iPhone's engine included).
function addShape(pts) {
  // Wind every shape the same way so overlapping shapes add up instead of cutting holes.
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p.x * q.y - q.x * p.y; }
  const list = a < 0 ? [...pts].reverse() : pts;
  g.moveTo(list[0].x, list[0].y);
  for (let i = 1; i < list.length; i++) g.lineTo(list[i].x, list[i].y);
  g.closePath();
}
function addCapsule(a, b, r) {
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * r, ny = (dx / len) * r;
  addShape([{ x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny }, { x: b.x - nx, y: b.y - ny }, { x: a.x - nx, y: a.y - ny }]);
  for (const c of [a, b]) { g.moveTo(c.x + r, c.y); g.arc(c.x, c.y, r, 0, Math.PI * 2, false); g.closePath(); }
}
function drawHandsOver(W, H) {
  g.save();
  g.beginPath();
  for (const hand of hands) {
    const lm = hand.landmarks.map((p) => ({ x: p.x * W, y: p.y * H }));
    const size = Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y);
    if (!(size > 1)) continue;
    addShape([0, 1, 2, 5, 9, 13, 17].map((i) => lm[i])); // palm
    for (const [a, b] of CONNECTIONS) addCapsule(lm[a], lm[b], size * 0.14); // fingers, palm edges
    // Forearm: a band from the wrist away from the fingers, to the picture's edge.
    const ux = (lm[0].x - lm[9].x) / size, uy = (lm[0].y - lm[9].y) / size, reach = W + H;
    const half = size * 0.55;
    const s0 = { x: lm[0].x - ux * size * 0.15, y: lm[0].y - uy * size * 0.15 }, s1 = { x: lm[0].x + ux * reach, y: lm[0].y + uy * reach };
    addShape([{ x: s0.x - uy * half, y: s0.y + ux * half }, { x: s1.x - uy * half, y: s1.y + ux * half }, { x: s1.x + uy * half, y: s1.y - ux * half }, { x: s0.x + uy * half, y: s0.y - ux * half }]);
  }
  g.clip('nonzero');
  const sx = (settings.mirror ? -1 : 1) * (settings.flip ? -1 : 1), sy = settings.flip ? -1 : 1;
  g.setTransform(sx, 0, 0, sy, sx < 0 ? W : 0, sy < 0 ? H : 0);
  g.drawImage(video, 0, 0, W, H);
  g.restore();
}

// ---------- tracking details: what the camera registers, finger by finger ----------
const STATE_COLORS = { idle: 'rgba(235,237,243,0.55)', armed: '#fbbf24', off: 'rgba(150,150,150,0.3)' };
const SHORT = ['T', 'I', 'M', 'R', 'P'];
let lastSeen = 0;

function drawTracking(now, W, H, dpr) {
  if (hands.length) lastSeen = now;
  const font = (px, weight = 400) => `${weight} ${px * dpr}px system-ui, sans-serif`;

  // Nothing seen for a moment: say so in the middle of the picture.
  if (!hands.length && now - lastSeen > 1200) {
    const tip = settings.mode === 'surface'
      ? 'Point the camera down at the table. Keep your whole hand in the picture, in good light.'
      : 'Hold your hands up in front of the camera, fully in the picture, in good light.';
    g.font = font(13);
    const tw = Math.min(W - 40 * dpr, Math.max(g.measureText(tip).width + 32 * dpr, 220 * dpr));
    const lines = wrapText(tip, tw - 32 * dpr);
    const bh = (44 + lines.length * 18) * dpr;
    const bx = (W - tw) / 2, by = H * 0.3 - bh / 2;
    g.fillStyle = 'rgba(15,17,23,0.82)';
    roundRect(bx, by, tw, bh, 10 * dpr, true); g.fill();
    g.fillStyle = '#ebedf3'; g.textAlign = 'center';
    g.font = font(15, 600); g.fillText('No hands in view', W / 2, by + 26 * dpr);
    g.font = font(13); g.fillStyle = '#9aa1b4';
    lines.forEach((l, i) => g.fillText(l, W / 2, by + (46 + i * 18) * dpr));
    return;
  }
  if (!hands.length) return;

  // Meter panel: one row per hand (named by where it is on screen), a bar per finger.
  const th = detector.thresholds();
  const scaleMax = settings.mode === 'zone' ? 1 : th.on * 2;
  const rows = [...hands].sort((a, b) => a.landmarks[0].x - b.landmarks[0].x);
  const barW = 14 * dpr, gap = 6 * dpr, barH = 40 * dpr, pad = 10 * dpr;
  const panelW = Math.max(pad * 2 + 5 * barW + 4 * gap + 58 * dpr, pad * 2 + 196 * dpr);
  const rowH = barH + 30 * dpr;
  const footer = 22 * dpr;
  const panelH = pad + rows.length * rowH + footer;
  const px = 10 * dpr, py = 62 * dpr; // below the toolbar
  g.fillStyle = 'rgba(15,17,23,0.78)';
  roundRect(px, py, panelW, panelH, 10 * dpr, true); g.fill();

  rows.forEach((hand, r) => {
    const name = rows.length === 1 ? 'Hand' : r === 0 ? 'Left hand' : 'Right hand';
    const ry = py + pad + r * rowH;
    g.textAlign = 'left'; g.font = font(12, 600); g.fillStyle = '#ebedf3';
    g.fillText(name, px + pad, ry + 10 * dpr);
    const bx0 = px + pad;
    const by0 = ry + 16 * dpr;
    for (let f = 0; f < 5; f++) {
      const st = detector.smoothed(`${hand.id}:${f}`);
      const x = bx0 + f * (barW + gap);
      g.fillStyle = 'rgba(255,255,255,0.08)';
      g.fillRect(x, by0, barW, barH);
      if (st) {
        const v = Math.max(0, Math.min(1, st.signal / scaleMax));
        g.fillStyle = st.state === 'pressed' ? settings.accent : STATE_COLORS[st.state];
        g.fillRect(x, by0 + barH * (1 - v), barW, barH * v);
      }
      // threshold lines: solid = arm/press, dashed = land/release
      if (settings.mode !== 'zone') {
        const yOn = by0 + barH * (1 - th.on / scaleMax), yOff = by0 + barH * (1 - th.off / scaleMax);
        g.strokeStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = 1 * dpr;
        g.beginPath(); g.moveTo(x - 1, yOn); g.lineTo(x + barW + 1, yOn); g.stroke();
        g.setLineDash([2 * dpr, 2 * dpr]);
        g.beginPath(); g.moveTo(x - 1, yOff); g.lineTo(x + barW + 1, yOff); g.stroke();
        g.setLineDash([]);
      }
      g.textAlign = 'center'; g.font = font(10); g.fillStyle = '#9aa1b4';
      g.fillText(SHORT[f], x + barW / 2, by0 + barH + 11 * dpr);
    }
    // the note(s) this hand is holding
    const held = [];
    for (let f = 0; f < 5; f++) { const k = active.get(`${hand.id}:${f}`); if (k) held.push(k.name); }
    g.textAlign = 'left'; g.font = font(12, 600); g.fillStyle = settings.accent;
    g.fillText(held.join(' '), bx0 + 5 * (barW + gap) + 4 * dpr, by0 + barH / 2 + 4 * dpr);
  });
  {
    const fy = py + pad + rows.length * rowH + 6 * dpr;
    let x = px + pad;
    g.textAlign = 'left'; g.font = font(11);
    g.fillStyle = fps < 15 ? '#fbbf24' : '#9aa1b4';
    const f = `${Math.round(fps)} fps`;
    g.fillText(f, x, fy + 4 * dpr);
    x += g.measureText(f).width + 8 * dpr;
    if (settings.mode !== 'zone') {
      const cal = !!detector.config.calibration;
      g.fillStyle = cal ? '#9aa1b4' : '#fbbf24';
      const c = cal ? 'calibrated' : 'not calibrated';
      g.fillText(c, x, fy + 4 * dpr);
      x += g.measureText(c).width + 8 * dpr;
    }
    if (settings.anchor) {
      g.beginPath(); g.arc(x + 4 * dpr, fy, 4 * dpr, 0, Math.PI * 2);
      g.fillStyle = follow.ok ? '#4ade80' : '#fbbf24'; g.fill();
      g.fillStyle = '#ebedf3';
      g.fillText(follow.ok ? 'pinned' : 'not pinned', x + 12 * dpr, fy + 4 * dpr);
    }
  }
}

function wrapText(text, maxW) {
  const words = text.split(' '), lines = [];
  let line = '';
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (g.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

function drawEditFrame(W, H, dpr) {
  const q = settings.quad.map(([x, y]) => [x * W, y * H]);
  g.save();
  g.setLineDash([8 * dpr, 6 * dpr]);
  g.strokeStyle = settings.accent;
  g.lineWidth = 2 * dpr;
  g.beginPath();
  q.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
  g.stroke();
  g.setLineDash([]);
  const coarse = matchMedia('(pointer: coarse)').matches;
  // Corners: big filled handles (they angle the keyboard). Edge midpoints: smaller (resize).
  q.forEach(([x, y], i) => {
    const [nx, ny] = q[(i + 1) % 4];
    handleDot((x + nx) / 2, (y + ny) / 2, (coarse ? 8 : 6) * dpr, 'rgba(15,17,23,0.85)', settings.accent);
  });
  q.forEach(([x, y]) => handleDot(x, y, (coarse ? 12 : 9) * dpr, settings.accent, 'rgba(0,0,0,0.6)'));
  g.restore();
}
function handleDot(x, y, r, fill, stroke) {
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fillStyle = fill; g.fill();
  g.strokeStyle = stroke; g.lineWidth = 2; g.stroke();
}

// Small label in the bottom corner saying whether the keyboard is following the table
// (shown when the tracking panel, which normally says this, is turned off).
function drawFollowBadge(W, H, dpr) {
  const text = follow.ok ? 'Pinned to table' : "Can't follow table: too plain or covered";
  g.font = `600 ${11 * dpr}px system-ui, sans-serif`;
  const tw = g.measureText(text).width + 26 * dpr, th = 20 * dpr;
  const x = W - tw - 8 * dpr, y = H - th - 8 * dpr;
  g.fillStyle = 'rgba(15,17,23,0.78)';
  roundRect(x, y, tw, th, th / 2, true); g.fill();
  g.beginPath(); g.arc(x + 11 * dpr, y + th / 2, 4 * dpr, 0, Math.PI * 2);
  g.fillStyle = follow.ok ? '#4ade80' : '#fbbf24'; g.fill();
  g.fillStyle = '#ebedf3'; g.textAlign = 'left';
  g.fillText(text, x + 20 * dpr, y + th / 2 + 4 * dpr);
}

function roundRect(x, y, w, h, r, all = false) {
  if (all) { g.beginPath(); g.roundRect ? g.roundRect(x, y, w, h, r) : g.rect(x, y, w, h); return; }
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
window.pollo = { settings, detector, get synth() { return synth; }, get layout() { return layout; }, get tableMotion() { return tableMotion; }, get follow() { return follow; }, effQuad, toScreen: (u, v) => place.toScreen(u, v) };
