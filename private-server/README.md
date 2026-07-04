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
| `WS`   | `/xiaozhi/v1/` | Realtime conversation: Opus in (16 kHz) → STT → LLM → TTS → Opus out (24 kHz), plus the tunneled MCP control layer (tool discovery + calls). |
| `POST` | `/xiaozhi/vision/explain` | Camera photo upload (multipart `question` + `file`). The device gets this URL via MCP `initialize`; the response body is returned verbatim to the LLM as the take_photo tool result. |
| `POST`/`GET` | `/xiaozhi/events/*` | Server-push events: make an idle device speak, change expression, or play a sound (see below). |

Per-utterance flow: the device brackets speech with `listen start` / `listen
stop`; on stop we decode the upstream Opus to PCM, transcribe it (STT), stream
the LLM reply sentence-by-sentence, synthesize each sentence to 24 kHz PCM,
Opus-encode it, and stream it back bracketed by `tts start` / `tts stop`.

### Tools (function calling)

The LLM can call tools during a turn ([`src/xiaozhi/tools/`](./src/xiaozhi/tools/)).
Two kinds share one registry, so the model sees a single flat function list:

- **Server tools** — run in this process. Defined in
  [`server-tools.ts`](./src/xiaozhi/tools/server-tools.ts); to add one, append
  an object with `name`/`description`/`parameters` (JSON Schema) and an
  `execute()` — it is auto-exposed to the model on the next turn.
- **Device tools** — run on the robot. Right after the websocket `hello`, the
  server speaks MCP (JSON-RPC tunneled in `{"type":"mcp"}` frames,
  [`src/xiaozhi/mcp/mcp-session.ts`](./src/xiaozhi/mcp/mcp-session.ts)):
  `initialize` hands the device the vision-upload URL + token, `tools/list`
  discovers what the firmware exposes (`self.camera.take_photo`,
  `self.robot.set_head_angles`, `self.robot.set_led_color`,
  `self.robot.go_to_sleep` — "stop listening" / "go away" sends the robot to
  standby — reminders, volume, …), and each LLM call becomes a `tools/call`
  round-trip. MCP names are
  dotted; they are exposed to the model with underscores
  (`self_camera_take_photo`) and mapped back on execution.

**"What can you see?"** end-to-end: STT → the LLM calls
`self.camera.take_photo` → server sends MCP `tools/call` → firmware captures a
photo (showing it on the LCD) and POSTs it to `/xiaozhi/vision/explain` → the
vision model answers the LLM's question about it → the reply is spoken. The
photo never leaves your LAN.

### Server-push events (notifications)

External producers — desktop notifiers, email hooks, a Claude Code hook that
fires when a prompt finishes — can push events to the device through
[`src/xiaozhi/events.controller.ts`](./src/xiaozhi/events.controller.ts). The
device keeps its conversation WebSocket open while idle (the server sends a
JSON keepalive so the firmware's 120 s channel timer never lapses), so no
polling and no firmware changes are involved.

| Method | Path | Body | Effect |
|---|---|---|---|
| `POST` | `/xiaozhi/events/say` | `{"text", "emotion"?, "deviceId"?}` | Speak `text` via TTS with the normal talking animation + speech bubble. |
| `POST` | `/xiaozhi/events/emotion` | `{"emotion", "deviceId"?}` | Change the facial expression immediately (`neutral`, `happy`, `laughing`, `angry`, `sad`, `crying`, `sleepy`, `doubtful`). |
| `POST` | `/xiaozhi/events/sound` | `{"name", "deviceId"?}` or multipart `file=<wav>` | Play a WAV (any rate/channels; decoded + resampled server-side). Named sounds live in [`sounds/`](./sounds). |
| `GET`  | `/xiaozhi/events/devices` | — | Connected devices + live state (speaking, queued events). |
| `GET`  | `/xiaozhi/events/sounds` | — | Named sounds available to `POST …/sound`. |

Every route requires `Authorization: Bearer $XIAOZHI_EVENTS_TOKEN`, and this
token **is enforced** (unset = API disabled with 503) — the API speaks
arbitrary text on a robot in your home.

```bash
curl -X POST http://localhost:12800/xiaozhi/events/say \
  -H "Authorization: Bearer $XIAOZHI_EVENTS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"text": "Claude finished processing your prompt.", "emotion": "happy"}'
```

Delivery semantics: a quiet device plays the event after a short quiet grace
(`EVENT_QUIET_GRACE_MS`, default 2 s of no conversation activity); if it is
speaking or the user is interacting, the event waits in a bounded FIFO
(`"queued"`, 429 when full) and plays when the turn ends. The user wins:
interrupting the robot (wake word / tap — anything that makes the device send
`listen start` or `abort`) cancels an in-flight event just like it cancels a
normal reply, and the quiet grace keeps the next event from starting over the
user's first words. Responses report acceptance, not completion: producers
fire and forget. `deviceId` (the device MAC, see `GET …/devices`) is only
needed with multiple robots; otherwise the newest connection is targeted.

### Required local servers (OpenAI-compatible, no cloud keys)

The pipeline is wired to three OpenAI-compatible HTTP servers via LangChain and
the `openai` SDK. Any server implementing these APIs works; the defaults target
localhost. API keys default to a dummy value.

| Role | OpenAI API | Default base URL | Example server |
|---|---|---|---|
| LLM | `/v1/chat/completions` (streaming, **tools** for function calling) | `http://127.0.0.1:10000/v1` | llama.cpp server |
| STT | `/inference` (whisper.cpp) or `/v1/audio/transcriptions` | `http://127.0.0.1:10010/inference` | whisper.cpp `whisper-server` (default, Metal); or speaches via `STT_BACKEND=openai` |
| TTS | `/v1/audio/speech` (`response_format: pcm`) | `http://127.0.0.1:50060/v1` | Kokoro-FastAPI / openedai-speech / Piper |
| Vision | `/v1/chat/completions` (image_url content) | `VISION_*`, defaults to `LLM_*` | multimodal llama.cpp (`--mmproj`) |

Audio rates line up with **no resampling**: upstream 16 kHz == whisper input;
TTS PCM 24 kHz == device downstream rate. Opus decode/encode uses `opusscript`
(pure WASM — no native addon to compile). Providers are pluggable behind the interfaces in
[`src/xiaozhi/ai/provider.interface.ts`](./src/xiaozhi/ai/provider.interface.ts).

### Configure & run

All settings are environment variables with localhost defaults — see
[`.env.example`](./.env.example) for the full list (`LLM_*`, `STT_*`, `TTS_*`,
`WEATHER_*`, `XIAOZHI_TOKEN`, `PUBLIC_WS_HOST`).

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
npm run sim          # no AI servers needed: hello handshake + MCP initialize/tools/list
npm run e2e          # full turn through all 3 services: mic Opus -> STT -> LLM -> TTS -> Opus
npm run e2e:vision   # "what can you see": full turn + MCP camera emulation + photo upload
npm run e2e:events   # server-push events: auth, emotion, sounds, queueing, preemption, say
npm run e2e:sleep    # "go away": the LLM calls self.robot.go_to_sleep and says goodbye
```

`npm run e2e` emulates the device end-to-end: it speaks a prompt (auto-generated
on macOS via `say`, or pass `WAV_PATH=` a 16 kHz mono WAV), runs one real turn,
and re-transcribes the reply audio to prove it's intelligible. Requires
private-server **and** the three AI servers to be running. Override with
`WS_URL` / `WHISPER_URL` / `E2E_PROMPT`.

`npm run e2e:vision` additionally emulates the firmware's MCP server and
camera: it answers `initialize`/`tools/list`, and when the LLM calls
`self.camera.take_photo` it uploads a test image (white circle on red) to the
vision endpoint exactly the way `StackChanCamera::Explain` does (chunked
multipart + bearer token), then asserts the reply audio describes it. Needs a
tool-capable, multimodal model behind the LLM/vision endpoints.

`npm run e2e:sleep` emulates the firmware's MCP server with the
`self.robot.go_to_sleep` tool (see `firmware/main/hal/hal_mcp.cpp` — the two
descriptions must stay in sync) and speaks dismissal phrases ("go away", "stop
listening", "go to sleep"), asserting the LLM calls the tool and finishes the
goodbye turn. Needs a tool-capable model behind the LLM endpoint.

`npm run e2e:events` emulates an idle device and drives the events API against
it. Needs only private-server, started for the test as
`PORT=12900 XIAOZHI_EVENTS_TOKEN=test-token XIAOZHI_KEEPALIVE_MS=1500 npm run
start:prod` (the `say` playback assertions are skipped when no TTS backend is
running). Override with `BASE_URL` / `EVENTS_TOKEN`.

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
