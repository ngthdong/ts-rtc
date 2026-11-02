export interface LocalMedia {
  /** Possibly without audio or video tracks; never null, so tracks can be added later. */
  stream: MediaStream;
  /** Why we have less than camera + microphone, if we do. */
  error: string | null;
}

const VIDEO = { width: 1280, height: 720, frameRate: 30 };

/** Every track we were given, to prove in tests that none outlives the call. */
const acquired = new Set<MediaStreamTrack>();

async function capture(constraints: MediaStreamConstraints): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  for (const track of stream.getTracks()) acquired.add(track);
  return stream;
}

/** Camera + mic if possible, mic only if the camera fails, otherwise receive-only. */
export async function getLocalMedia(): Promise<LocalMedia> {
  try {
    return { stream: await capture({ audio: true, video: VIDEO }), error: null };
  } catch (err) {
    const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    try {
      return { stream: await capture({ audio: true }), error: `camera unavailable (${reason})` };
    } catch {
      return { stream: new MediaStream(), error: `camera and microphone unavailable (${reason})` };
    }
  }
}

/** A device the call started without (e.g. the camera, after joining audio-only). */
export async function getTrack(kind: 'audio' | 'video'): Promise<MediaStreamTrack> {
  const stream = await capture(kind === 'audio' ? { audio: true } : { video: VIDEO });
  const track = stream.getTracks()[0];
  if (!track) throw new Error(`no ${kind} device`);
  return track;
}

export function liveLocalTracks(): number {
  return [...acquired].filter((track) => track.readyState === 'live').length;
}

export function stopTracks(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}
