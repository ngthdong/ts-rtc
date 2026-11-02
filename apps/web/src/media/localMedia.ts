export interface LocalMedia {
  stream: MediaStream | null;
  error: string | null;
}

export async function getLocalMedia(): Promise<LocalMedia> {
  const video = { width: 1280, height: 720, frameRate: 30 };
  try {
    return {
      stream: await navigator.mediaDevices.getUserMedia({ audio: true, video }),
      error: null,
    };
  } catch (err) {
    const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      return { stream, error: `camera unavailable (${reason})` };
    } catch {
      return { stream: null, error: `camera and microphone unavailable (${reason})` };
    }
  }
}

export function stopTracks(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}
