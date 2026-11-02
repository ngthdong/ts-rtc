import { expect, test, vi } from 'vitest';
import { PeerSession } from './PeerSession.js';

function fakePeerConnection() {
  const calls: string[] = [];
  let finishRemote = () => {};
  const pc = {
    signalingState: 'stable',
    connectionState: 'new',
    localDescription: { type: 'answer', sdp: 'local' },
    addTrack: vi.fn(),
    addTransceiver: vi.fn(),
    close: vi.fn(),
    setRemoteDescription: vi.fn(() => {
      calls.push('setRemoteDescription');
      return new Promise<void>((resolve) => (finishRemote = resolve));
    }),
    setLocalDescription: vi.fn(() => {
      calls.push('setLocalDescription');
      return Promise.resolve();
    }),
    addIceCandidate: vi.fn(() => {
      calls.push('addIceCandidate');
      return Promise.resolve();
    }),
  };
  return { pc, calls, finishRemote: () => finishRemote() };
}

function session(fake: ReturnType<typeof fakePeerConnection>, send = vi.fn()) {
  const peer = new PeerSession({
    polite: true,
    localStream: { getTracks: () => [] } as unknown as MediaStream,
    send,
    onChange: () => {},
    createPeerConnection: () => fake.pc as unknown as RTCPeerConnection,
    config: {},
  });
  return { peer, send };
}

const offer = { description: { type: 'offer', sdp: 'remote' } } as const;
const candidate = { candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.1 5000 typ host' } };

test('a candidate that arrives during setRemoteDescription waits for it', async () => {
  const fake = fakePeerConnection();
  const { peer, send } = session(fake);
  void peer.handle(offer);
  const done = peer.handle(candidate);
  await Promise.resolve();
  expect(fake.calls).toEqual(['setRemoteDescription']); // candidate not applied yet
  fake.finishRemote();
  await done;
  expect(fake.calls).toEqual(['setRemoteDescription', 'setLocalDescription', 'addIceCandidate']);
  expect(send).toHaveBeenCalledWith({ description: { type: 'answer', sdp: 'local' } });
});

test('without local media it still asks to receive audio and video', () => {
  const fake = fakePeerConnection();
  session(fake);
  expect(fake.pc.addTransceiver).toHaveBeenCalledWith('audio', { direction: 'recvonly' });
  expect(fake.pc.addTransceiver).toHaveBeenCalledWith('video', { direction: 'recvonly' });
});

test('close is idempotent and later signals are dropped', async () => {
  const fake = fakePeerConnection();
  const { peer } = session(fake);
  peer.close();
  peer.close();
  expect(fake.pc.close).toHaveBeenCalledTimes(1);
  await peer.handle(offer);
  expect(fake.calls).toEqual([]);
});
