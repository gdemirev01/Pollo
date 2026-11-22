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
    /** Returns hands in raw camera coordinates (0..1); the app applies mirror/flip. */
    detect(video, timestampMs) {
      const res = landmarker.detectForVideo(video, timestampMs);
      const used = new Set();
      return (res.landmarks || []).map((lm, i) => {
        let id = res.handedness?.[i]?.[0]?.categoryName ?? `Hand${i}`;
        if (used.has(id)) id = `${id}${i}`; // both hands got the same label
        used.add(id);
        return { id, landmarks: lm };
      });
    },
  };
}
