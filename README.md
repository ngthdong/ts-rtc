# ts-rtc

Real-time video conferencing in TypeScript, built up from WebRTC primitives: peer-to-peer mesh calls first, then a mediasoup SFU with simulcast, TURN relaying, accounts and private rooms, and recovery from network drops and media-server crashes.

---

## Features 
- **Group calls:** Up to 10 people per SFU room, 4 per mesh room. Camera, microphone, screen sharing and active-speaker highlight.

- **Simulcast:** The camera is sent in 3 VP8 layers (L1T3). The SFU forwards each receiver the best layer its bandwidth allows.
- **Connectivity:** Short-lived credentials for coturn TURN (UDP and TCP relay), and ICE-TCP straight to the SFU when UDP is blocked.
- **Accounts:** Argon2id password hashing, HS256 JWT sessions, and public or private rooms in PostgreSQL. One authorization policy, can(), is checked on every room and media operation.
- **Recovery:** Reconnects with jittered backoff and resumes the same membership within a 30 s grace period, using a rotated single-use token and epoch-checked bindings. Also handles ICE restart, media rebuild, and mediasoup Worker crashes.

---

## Quick start

Requirements: Node 24, pnpm 10, and Docker for Postgres and coturn. Built and tested on Linux. coturn runs with host networking; for Docker Desktop on macOS or Windows, see the TURN runbook.

```bash
git clone https://github.com/ngthdong/ts-rtc.git && cd ts-rtc
pnpm install
cp .env.example .env # set TURN_SECRET=$(openssl rand -hex 32)
docker compose up -d --wait postgres coturn
pnpm dev # server :4000, web :5173
```

Open http://localhost:5173 in two browser windows, and create an account in each.

Click `Create room` in one window, then paste its room ID into the other.

Other modes:
- `?mode=mesh` makes a mesh room.
- `SFU loopback test` sends your own media through the SFU and back to you.
- In development the server also serves `GET /api/openapi.json` (the HTTP API) and `GET /debug/media` (live transport, Producer and Consumer counts).

## Benchmarks
 
All numbers below come from one 2-vCPU cloud sandbox, with every browser running on that same
machine. They show trends and relative costs, not capacity. To reproduce:
 
- `pnpm bench` for mesh vs SFU;
- `pnpm --filter @ts-rtc/server exec tsx bench/media.ts` for mediasoup;
- `pnpm --filter @ts-rtc/server exec tsx bench/argon2.ts` for password hashing.
**Mesh vs SFU.** Per browser, measured after 30 s of bandwidth ramp-up:
 
| People | Mode | Encoders | Upload   | Download   | Received video                                  |
| ------ | ---- | -------- | -------- | ---------- | ----------------------------------------------- |
| 2      | Mesh | 1        | 721 kbps | 722 kbps   | 720p @ 20 fps                                   |
| 2      | SFU  | 1        | 730 kbps | 733 kbps   | 720p @ 20 fps                                   |
| 4      | Mesh | 3        | 896 kbps | 896 kbps   | 705p @ 7 fps                                    |
| 4      | SFU  | 1        | 479 kbps | 1,447 kbps | 666p @ 13 fps                                   |
| 6      | Mesh | 5        | —        | —          | did not finish connecting (30 peer connections) |
| 6      | SFU  | 1        | 240 kbps | 1,243 kbps | 636p @ 6 fps                                    |
 
At 4 people the SFU halves each browser's upload, because it encodes once instead of three
times. It also nearly doubles the received frame rate on the same saturated CPU. The SFU Worker
itself used about 5 % of one core.
 
**Media server** (mediasoup 3.32):
 
| Operation                                                              | Result                  |
| ---------------------------------------------------------------------- | ----------------------- |
| Worker startup (p50) / idle RSS                                        | 18–19 ms / 18–20 MiB    |
| `createRouter`, p50 / p99 of 1,000                                     | 0.3–0.4 ms / 1.3–2.9 ms |
| `createWebRtcTransport` / `consume`, p50                               | 0.13–0.16 ms / 0.38 ms  |
| Transport to DTLS connected (send, median): UDP / TURN relay / ICE-TCP | 44 / 108 / 216 ms       |
 
**Simulcast and recovery.** These figures are upper bounds; the measurement windows include
2 s media samples.
 
| Scenario                              | Result                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| One receiver throttled to 400 kbit/s  | it fell to the 320 px layer within 3.9 s; others kept 1280 px                   |
| Signaling dropped for 3 s             | media kept flowing; same member resumed within 3.4–6.4 s                        |
| Media path lost for 12 s              | ICE restart on the same transports; media back within 6 s of the path returning |
| mediasoup Worker SIGKILLed (3 people) | new Router, every client rebuilt, media back within 9 s; no leaked objects      |
 
**Other.**
 
- Argon2id at 46 MiB, t=3: 44–56 ms per hash.
- Membership lookup on each join: 0.06 ms with 50,000 memberships (index-only scan).
