import type { types } from 'mediasoup';

/**
 * What every Router offers. Changing this list changes negotiation for every client, so it is
 * an ADR-level decision (VP9 and AV1 are deferred).
 */
export const MEDIA_CODECS: types.RouterRtpCodecCapability[] = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48_000, channels: 2 },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90_000 },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90_000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42e01f',
      'level-asymmetry-allowed': 1,
    },
  },
];
