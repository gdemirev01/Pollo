# Pollo — air piano

Play the piano in the air. Your webcam watches your hands, [MediaPipe Hand Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker) finds 21 points on each hand, and a Web Audio synth plays the keys your fingers strike. Everything runs locally in the browser; no video leaves your machine.

## Run it

ES modules and camera access need the page served from `localhost` (not opened as `file://`):

```bash
python3 -m http.server 8000      # or: npm start
# then open http://localhost:8000 in Chrome / Edge / Firefox
```

Press **Start**, allow the camera, and hold your hands up so they're over the on-screen keyboard.

### Setting it up on a table

1. Prop your phone, tablet or laptop on the table with the front camera facing you, a little above your hands.
2. Press **Move keys** (the arrows button) and drag the keyboard to where your hands are. Drag an edge or corner to resize it. Press **Done**.
3. Adjust in **Settings**: lowest note, number of keys (5–36 white keys), note names, key opacity, pressed-key colour, camera (front, back or a specific device), mirror, and upside down for a camera mounted flipped.

### Putting the keyboard on the table

- **Snap to hands**: press it, then rest your hands on the table where you want to play and hold still for about a second. The keyboard lands under your fingertips, lined up with them, sized to your hand span. It stays there: it only moves when you use **Move keys** or snap again.
- **Angle it onto the table**: in **Move keys**, drag a corner to where the table's surface really is (or onto the corners of a paper keyboard). The keys are drawn and hit-tested in perspective. Drag inside to move, drag an edge to resize, **Rectangle** to straighten it out.
- **Keep keyboard pinned to the table if the camera moves** (on by default): the app remembers what the table looks like around the keyboard and slides the keyboard along if the phone shifts or wobbles. Hands are left out of the comparison. It needs some texture to lock on to (wood grain, a cloth, a printed sheet); on a plain white table it says *Can't follow table*. It follows sliding, not rotating or zooming.

### Using the back camera from above (Table mode)

Mount the phone over the table with the back camera pointing down (a phone stand, gooseneck or shelf), open the app and pick **Table** in Settings: it switches to the back camera and turns mirroring off. Use **Upside down** if the picture is rotated, then **Move keys** to place the keyboard where your hands rest.

### Watching what the camera registers

**Show tracking details** (on by default) draws a panel with a meter per finger for each hand in view:

- the bar is the finger's current signal (Table: how far it's lifted; Tap: how far it's pushed down),
- the solid line is where it arms/presses and the dotted line where it lands/releases,
- grey = resting, amber = lifted and ready to strike, your accent colour = playing; the notes being held are listed beside it.

A lifted fingertip also gets an amber ring on the video. If no hand is found for a moment, a message in the middle of the picture says so. Use **Tap sensitivity** to move the thresholds.

Settings and the keyboard position are saved in the browser. You can also play by touching or clicking the keys on screen. **Full screen** and keep-screen-awake help when it's propped up on a phone.

### Online (GitHub Pages)

`.github/workflows/pages.yml` runs the tests and publishes the app on every push to `main`. One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**. The app is then live at `https://<your-user>.github.io/<repo>/`. Pages serves over https, which browsers require for camera access.

## How to play

| Mode | Gesture |
| --- | --- |
| **Tap** (default) | Hover your hands over the keys, then push **one finger down below the others**, like striking a key. Lift it back to release. The whole hand moving doesn't play anything; only a finger dropping relative to its neighbours. Thumbs are off by default (enable in settings). |
| **Zone** | Any fingertip that enters a key plays it. Slide along the keys for a glissando. |
| **Table** | Camera **above, looking down** (e.g. a phone's back camera on a stand). Rest your hands on the table, lift a finger and tap it back down: the note plays when it lands, on the key under that fingertip. Lifting the finger again lets go of the note. |

- **Velocity**: strike faster for a louder note.
- **Sustain pedal**: <kbd>Space</kbd> or the checkbox.
- **Keyboard fallback**: <kbd>A W S E D F T G Y H U J K …</kbd> play notes from the start octave (useful to test audio).
- **Tap sensitivity** slider: raise it if strikes are missed, lower it if notes trigger by accident.

Tips: good front lighting, a plain background, and the camera at about chest height looking at your hands work best.

## How it works

```
webcam ─► MediaPipe HandLandmarker (WASM + GPU) ─► landmarks (mirrored to match the screen)
                                                        │
                                        src/detector.js │  per-finger state machine
                                                        ▼
                                           note on / off events ─► src/synth.js (Web Audio)
```

- `src/hands.js` — loads the model from the MediaPipe CDN; GPU delegate with CPU fallback.
- `src/detector.js` — pure logic. For each fingertip: smoothing, then
  - *tap*: `drop = (tipY − mean(other fingertips' Y)) / handSize`; press above `pressThreshold`, release below `releaseThreshold` (hysteresis prevents chattering). Hand size = wrist→middle-knuckle distance, so it works at any distance from the camera.
  - *zone*: hit-test the fingertip against the key rectangles, with a small hysteresis margin at the keyboard's top edge.
  - Velocity comes from the fingertip's downward speed.
- `src/piano.js` — keyboard geometry and hit testing (black keys on top).
- `src/homography.js` — perspective mapping between keyboard space and the four corners on screen.
- `src/layout-editor.js` — moving, angling and resizing the keyboard's corners.
- `src/snap.js` — waits for still hands and fits the keyboard under the fingertips.
- `src/stabilizer.js` — follows the table if the camera shifts (masked, coarse-to-fine block matching).
- `src/settings.js` — defaults and saving to `localStorage`.
- `src/synth.js` — additive piano voice: inharmonic partials that decay at different rates, a filtered noise "hammer", velocity-dependent brightness, convolution reverb, sustain pedal. Voices are keyed by finger, so two fingers on one key don't cut each other off.
- `src/main.js` — camera selection, mirror/flip, render loop, touch play, edit mode, UI.

## Tests

```bash
npm test     # node --test, no dependencies
```

## Ideas for next steps

- MIDI output (Web MIDI) to drive a real synth or DAW
- Sampled piano sounds instead of the synth
- Record / play back, or a "falling notes" lesson mode
