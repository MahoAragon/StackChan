# StackChan private-server

A local **NestJS** server that takes over the role of the StackChan
avatar/app backend (the self-hosted "StackChan World" server, normally at
`http://47.113.125.164:12800`). It implements **dummy versions of every
endpoint and WebSocket message the StackChan firmware needs to function**, so
you can build and flash the firmware and have it talk to an instance running on
your own machine.

> Scope: this replaces the StackChan avatar/app backend (backend #2 in
> [`firmware/docs/server-api-architecture.md`](../firmware/docs/server-api-architecture.md))
> **and** provides a self-hosted, cloud-free drop-in for the xiaozhi AI
> conversation server (`api.tenclass.net`) — see [Xiaozhi AI backend](#xiaozhi-ai-backend)
> below. The M5Stack EzData/UIFlow2 cloud and the OTA cloud remain pointed at
> their defaults.

## What it implements

Everything the firmware actually calls on this backend, verified against the
firmware source (`hal_ws_avatar.cpp`, `hal_account.cpp`, `hal_app_center.cpp`):

### HTTP (device-facing) — GoFrame `{ code, message, data }` envelope, `code: 0` = success

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/stackChan/device/user`   | Bound username (returns `null` when unbound) |
| `GET`  | `/stackChan/device/info`   | Device display name |
| `POST` | `/stackChan/device/unbind` | Unbind the device from its account |
| `GET`  | `/stackChan/apps`          | App-store list |

### WebSocket — `ws://<host>:12800/stackChan/ws?deviceType=StackChan`

- Accepts the firmware's `Authorization: hi-stack-chan` header (logged, not enforced).
- Reads the plaintext `hello`, speaks the binary framing
  `[1-byte type][4-byte big-endian length][payload]`.
- Sends `HeartbeatPing` every 4 s and tracks `HeartbeatPong` (firmware watchdog
  fires at 10 s).
- Handles every device→server message: `Jpeg` camera frames, `HeartbeatPong`,
  `AcceptCall`/`DeclineCall`/`EndCall`, `GetDeviceName` replies, `Opus`.
- Can push every server→device message: `ControlAvatar`, `ControlMotion`,
  `DanceSequence`, `TextMessage`, `RequestCall`/`EndCall`, `SetDeviceName`/
  `GetDeviceName`, `Start`/`StopCameraStream`, `VideoModeOn`/`Off`.

### Dev control surface (NOT part of the firmware protocol) — under `/control`

HTTP endpoints to drive a connected device by hand. Payloads default to valid
built-in demos (shapes from `firmware/main/stackchan/json/json_helper.cpp`):

| Method | Path | Body (optional) |
|---|---|---|
| `GET`  | `/control/devices`            | — list connected devices |
| `POST` | `/control/avatar`             | avatar JSON `{leftEye,rightEye,mouth}` |
| `POST` | `/control/motion`             | motion JSON `{yawServo,pitchServo}` |
| `POST` | `/control/dance`              | dance JSON **array** of keyframes |
| `POST` | `/control/text`               | `{ "name", "content" }` |
| `POST` | `/control/device-name`        | `{ "name" }` |
| `POST` | `/control/call/request`       | `{ "caller" }` |
| `POST` | `/control/call/end`           | — |
| `POST` | `/control/camera/start`\|`stop` | — toggle camera stream |
| `POST` | `/control/video-mode/on`\|`off` | — |
| `GET`  | `/control/camera/frame.jpg`   | — latest camera frame as JPEG |

## Run it

```bash
cd private-server
npm install
npm run start          # or: npm run start:dev  (watch mode)
```

Listens on `0.0.0.0:12800` by default (matches the production server port).
Override with `PORT` / `HOST` env vars.

Quick check once it's up:

```bash
curl -H 'Authorization: hi-stack-chan' http://localhost:12800/stackChan/device/user
# {"code":0,"message":"","data":{"username":"LocalDev"}}
```

Once a device is connected, try:

```bash
curl -X POST http://localhost:12800/control/dance      # make it dance
curl -X POST http://localhost:12800/control/call/request -d '{"caller":"Maho"}'  # ring it
```

## Xiaozhi AI backend

This server also hosts a **self-hosted, cloud-free replacement for the xiaozhi
AI conversation backend** (normally `api.tenclass.net`), so the device's voice
assistant runs entirely on your LAN and never contacts tenclass or the M5Stack
cloud. It speaks the exact WebSocket protocol the firmware enforces
(`firmware/xiaozhi-esp32/main/protocols/websocket_protocol.cc`).

### Endpoints (same host/port, `12800`)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/xiaozhi/ota` | Bootstrap. Returns **only** a `websocket` block (URL + token) and no `mqtt`/`firmware`/`activation`, so the device selects WebSocket and skips cloud activation/upgrade. |
| `WS`   | `/xiaozhi/v1/` | Realtime conversation: Opus in (16 kHz) → STT → LLM → TTS → Opus out (24 kHz). |

Per-utterance flow: the device brackets speech with `listen start` / `listen
stop`; on stop we decode the upstream Opus to PCM, transcribe it (STT), stream
the LLM reply sentence-by-sentence, synthesize each sentence to 24 kHz PCM,
Opus-encode it, and stream it back bracketed by `tts start` / `tts stop`.

### Required local servers (OpenAI-compatible, no cloud keys)

The pipeline is wired to three OpenAI-compatible HTTP servers via LangChain and
the `openai` SDK. Any server implementing these APIs works; the defaults target
localhost. API keys default to a dummy value.

| Role | OpenAI API | Default base URL | Example server |
|---|---|---|---|
| LLM | `/v1/chat/completions` (streaming) | `http://127.0.0.1:10000/v1` | llama.cpp server |
| STT | `/inference` (whisper.cpp) or `/v1/audio/transcriptions` | `http://127.0.0.1:10010/inference` | whisper.cpp `whisper-server` (default, Metal); or speaches via `STT_BACKEND=openai` |
| TTS | `/v1/audio/speech` (`response_format: pcm`) | `http://127.0.0.1:50060/v1` | Kokoro-FastAPI / openedai-speech / Piper |

Audio rates line up with **no resampling**: upstream 16 kHz == whisper input;
TTS PCM 24 kHz == device downstream rate. Opus decode/encode uses `opusscript`
(pure WASM — no native addon to compile). Providers are pluggable behind the interfaces in
[`src/xiaozhi/ai/provider.interface.ts`](./src/xiaozhi/ai/provider.interface.ts).

### Configure & run

All settings are environment variables with localhost defaults — see
[`.env.example`](./.env.example) for the full list (`LLM_*`, `STT_*`, `TTS_*`,
`XIAOZHI_TOKEN`, `PUBLIC_WS_HOST`).

```bash
# 1. start your local llama.cpp / whisper / TTS servers (see table above)
# 2. run private-server (env vars optional; defaults point at localhost)
npm install
npm run start
```

Point the firmware's xiaozhi OTA URL at `http://<your-lan-ip>:12800/xiaozhi/ota`
so the device bootstraps onto this backend instead of the cloud. Quick check:

```bash
curl -X POST http://localhost:12800/xiaozhi/ota
# {"websocket":{"url":"ws://localhost:12800/xiaozhi/v1/","token":"stackchan","version":1}}
```

### Tests (no hardware required)

```bash
npm run sim   # handshake only: connects to /xiaozhi/v1/ and checks the server hello
npm run e2e   # full turn through all 3 services: mic Opus -> STT -> LLM -> TTS -> Opus
```

`npm run e2e` emulates the device end-to-end: it speaks a prompt (auto-generated
on macOS via `say`, or pass `WAV_PATH=` a 16 kHz mono WAV), runs one real turn,
and re-transcribes the reply audio to prove it's intelligible. Requires
private-server **and** the three AI servers to be running. Override with
`WS_URL` / `WHISPER_URL` / `E2E_PROMPT`.

## Point the firmware at this server, build & flash

The firmware base URL is the Kconfig symbol `CONFIG_STACKCHAN_SERVER_URL`
(`firmware/main/Kconfig.projbuild`). It must be your machine's **LAN IP**, not
`localhost` — the device reaches the server over Wi-Fi.

This repo is already wired up:

- [`firmware/sdkconfig.defaults.local`](../firmware/sdkconfig.defaults.local)
  (git-ignored overlay, auto-applied by `firmware/CMakeLists.txt`) sets the URL.
- The active `firmware/sdkconfig` has been updated to match so an incremental
  build works immediately.

Both currently point at `http://10.0.0.200:12800`. **If your machine's IP
differs**, update both files (or just edit the active `sdkconfig` value), then:

```bash
cd firmware
idf.py set-target esp32s3        # first time only
idf.py build
idf.py -p <PORT> flash monitor   # e.g. -p /dev/cu.usbmodem...
```

Find your IP with `ipconfig getifaddr en0` (macOS). Make sure the device and
this computer are on the same network and your firewall allows inbound TCP on
port 12800.

On boot, the device's Avatar app connects to `ws://<your-ip>:12800/stackChan/ws`;
you'll see `Device #1 connected ...` in the server log, and the `/control/*`
endpoints will drive it.
```
