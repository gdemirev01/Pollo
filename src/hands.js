// Thin wrapper around MediaPipe's HandLandmarker.
const VERSION = '0.10.14';
const BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
const MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export async function createHandTracker({ numHands = 2 } = {}) {
  const { FilesetResolver, HandLandmarker } = await import(`${BASE}/vision_bundle.mjs`);
  const fileset = await FilesetResolver.forVisionTasks(`${BASE}/wasm`);
  const make = (delegate) => HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: 'VIDEO',
    numHands,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  let landmarker, delegate = 'GPU';
  try { landmarker = await make('GPU'); }
  catch (e) { console.warn('GPU delegate failed, falling back to CPU', e); delegate = 'CPU'; landmarker = await make('CPU'); }

  return {
    delegate,
    /** Returns hands in *mirrored display* coordinates. */
    detect(video, timestampMs) {
      const res = landmarker.detectForVideo(video, timestampMs);
      const used = new Set();
      return (res.landmarks || []).map((lm, i) => {
        // MediaPipe assumes a mirrored (selfie) image; we feed the raw camera
        // frame, so its label is the opposite of the player's actual hand.
        const raw = res.handedness?.[i]?.[0]?.categoryName;
        let id = raw === 'Left' ? 'Right' : raw === 'Right' ? 'Left' : `Hand${i}`;
        if (used.has(id)) id = `${id}${i}`; // both hands got the same label
        used.add(id);
        return { id, landmarks: lm.map((p) => ({ x: 1 - p.x, y: p.y, z: p.z })) };
      });
    },
  };
}
