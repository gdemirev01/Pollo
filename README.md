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

- **Automatic placement**: when the camera comes on, hold your hands still where you want to play and the keyboard appears under them (with the front camera too). Press **Skip** to keep the last position instead. Turn it off with *Place keyboard under my hands when the camera first sees them*. With the camera in front of you the keyboard stays upright; in Table mode it faces the keys toward your wrists.
- **Keys keep fitting your fingers** (on by default): while you play, if the keys under your hand get more than 10% wider or narrower than the gap between your fingertips (the phone moved closer or further away), the keyboard smoothly resizes around your hand over about a second. The key under your hand stays the same, and moving your hand sideways still plays other keys. When the keyboard is pinned to a textured surface the table tracker already handles this.
- **The piano appears with your hands**: it fades in when a hand comes into view and fades out a couple of seconds after your hands leave (always shown while moving keys, or without a camera).
- **Snap to hands**: press it, then rest your hands on the table where you want to play and hold still for about a second. The keyboard lands under your fingertips, lined up with them, with each white key as wide as the gap between your fingertips (one key per finger, like a real piano); if your chosen number of keys wouldn't fit on screen at that size, it uses fewer and says so. It stays there: it only moves when you use **Move keys** or snap again.
- **Angle it onto the table**: in **Move keys**, drag a corner to where the table's surface really is (or onto the corners of a paper keyboard). The keys are drawn and hit-tested in perspective. Drag inside to move, drag an edge to resize, **Rectangle** to straighten it out.
- **Keep keyboard pinned to the table when the phone moves** (on by default): the app picks dozens of textured points on the table (away from your hands), follows each of them every frame, and works out how the table moved in the picture: sliding, turning, zooming or tilting. The keyboard moves with it, so it stays on the same spot of the table. When points leave the picture it picks up fresh ones. It needs a surface with some pattern to lock on to (wood grain, a patterned cloth); on a plain table or a bedsheet it can't, and says so. For those, print the **Pollo mat** (`mat.html`, linked in Settings): a calm, non-repeating pattern made for the tracker. Put it under your hands and play on it. Sudden big jerks can lose it: hold the phone still for a moment and it picks the table up again. While your hands and arms cover most of the table (when you're playing), it holds the keyboard exactly still instead of guessing from the few points left, and resumes following as soon as enough table is visible again. Hands and forearms are left out of the tracking.

### Using the back camera from above (Table mode)

Mount the phone over the table with the back camera pointing down (a phone stand, gooseneck or shelf), open the app and pick **Tap the table (camera above)** in Settings: it switches to the back camera and turns mirroring off. Use **Upside down** if the picture is rotated.

### 3D keys on the table

The keyboard is drawn as a real 3D piano standing on the table: key blocks at real proportions (white keys 2.35 cm wide and 15 cm long), raised black keys, a case and a soft shadow, seen in the table's perspective. Pressed keys sink and light up. Your hands and forearms are cut out of the camera picture and drawn in front of the keys, so your fingers sit on them.

How it works: the keyboard's four corners give the table's perspective; together with the camera's angle of view that tells the app where the camera is relative to the table, and so which way is "up" at every point. For the best effect, angle the keyboard's corners onto the table (Move keys, or Snap to hands with the camera above). Settings: **3D keys**, **Key height**, **Camera angle of view** (if the keys seem to lean or stretch, adjust this until they stand straight; most phone cameras are 60–75°), **Show my hands in front of the keys**.

### Calibrating taps

Every camera angle shows a tap differently: from the front the fingertip moves up and down in the picture, from straight above it mostly gets closer to the camera, and from an angle above it may slide sideways. Press **Calibrate taps**. Step 1: rest your hand flat on the table and keep it still for 2 seconds (so the app knows exactly where *resting* is). Step 2: tap each finger a few times for about 8 seconds. The app learns which way your taps move in the picture from this camera angle and how big they are for each finger, and sets the thresholds from your own taps. It tells you how many taps it saw per finger; if one shows 0, calibrate again and include that finger. If it only saw jitter (no clear taps) it says so and keeps the previous setting. Calibration is saved separately for the front and overhead modes; **Clear calibration** goes back to the defaults.

### Watching what the camera registers

**Show tracking details** (on by default) draws a panel with a meter per finger for each hand in view:

- the bar is how high the finger is above the table (its learned resting level),
- the solid line is how high it has to be lifted for a tap to count, the dotted line is where it counts as touching the table,
- grey = resting, amber = lifted and ready to strike, your accent colour = playing; the notes being held are listed beside it.

The bottom line of the panel shows the frame rate (amber below 15 fps, when quick taps can be missed), whether taps are calibrated, and whether the keyboard is pinned to the table. A lifted fingertip also gets an amber ring on the video. If no hand is found for a moment, a message in the middle of the picture says so. **Tap sensitivity**: higher means smaller, gentler taps count.

Settings and the keyboard position are saved in the browser. You can also play by touching or clicking the keys on screen. **Full screen** and keep-screen-awake help when it's propped up on a phone.

### Online (GitHub Pages)

`.github/workflows/pages.yml` runs the tests and publishes the app on every push to `main`. One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**. The app is then live at `https://<your-user>.github.io/<repo>/`. Pages serves over https, which browsers require for camera access.

## How to play

| Mode | Gesture |
| --- | --- |
| **Tap the table, camera in front** (default) | Rest your fingers on the table, lift one and tap it down. The note plays the moment it hits the table, on the key under that fingertip, and stops when you lift it. Each finger is measured against its own knuckle, so moving your whole hand doesn't play; a slow lowering doesn't play either (it needs a tap). If neighbouring fingers twitch along with a tap only the tapping finger plays, but real chords work. Thumbs are off by default. |
| **Touch** (zone) | Any fingertip that enters a key plays it. Slide along the keys for a glissando. |
| **Tap the table, camera above** | Same, with the phone above the table looking down. From above, a lifted finger is seen as the fingertip coming closer to the camera and the finger looking shorter. |

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
- `src/surface-tracker.js` — keeps the keyboard on the table when the phone moves: corner points, warped-patch matching, robust perspective fit, re-seeding.
- `src/ar.js` — camera pose from the keyboard's corners and the angle of view; 3D key boxes and which faces are visible.
- `src/autosize.js` — keeps white keys about one finger-gap wide, scaling around the hand.
- `src/calibrate.js` — tap calibration: learns the tap direction (principal component of knuckle-relative fingertip features) and per-finger tap size.
- `src/filters.js` — One Euro filter that smooths hand landmarks without lagging fast taps.
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
