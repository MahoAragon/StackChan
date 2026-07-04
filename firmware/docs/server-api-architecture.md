# Server API & Communication Architecture

> Reference for how the StackChan firmware talks to its backend servers: transports,
> protocols, message framing, and auth. Read this first when debugging or extending
> anything network/API/protocol related.
>
> This firmware is a StackChan application layered on top of a **vendored copy of
> [`xiaozhi-esp32`](../xiaozhi-esp32)**. There is **no single "server"** — the device
> talks to **three distinct backends**, each with a different API style. They are
> independent; don't confuse them.

| Backend | API type | Transport | Payload | Code |
|---|---|---|---|---|
| **OTA / provisioning** | REST-style HTTP | HTTPS POST | JSON config (selects transport, URLs, tokens, firmware) | [`ota.cc`](../xiaozhi-esp32/main/ota.cc) |
| **AI assistant (xiaozhi)** | Real-time streaming + RPC | WebSocket **or** MQTT(TLS)+UDP | JSON control + binary Opus audio; MCP JSON-RPC tunneled in | [`protocols/`](../xiaozhi-esp32/main/protocols) |
| **StackChan avatar / video-call** | Real-time bidirectional | WebSocket | Custom `[type][len][payload]` binary; JSON hello; JPEG video | [`hal_ws_avatar.cpp`](../main/hal/hal_ws_avatar.cpp) |
| **M5Stack EzData / UIFlow2** | IoT data / pairing | HTTPS + MQTT | JSON over `$ezdata/{token}/up`/`down` | [`hal_ezdata.cpp`](../main/hal/hal_ezdata.cpp) |

---

## 1. The AI assistant server (core of xiaozhi)

This is the main "talk to the AI" path. It has three sub-parts: an HTTP bootstrap, a
runtime streaming transport, and an MCP control layer tunneled over that transport.

### 1a. Bootstrap — HTTP(S) config / OTA endpoint

Source: [`xiaozhi-esp32/main/ota.cc`](../xiaozhi-esp32/main/ota.cc),
[`ota.h`](../xiaozhi-esp32/main/ota.h),
[`hal_ota.cpp`](../main/hal/hal_ota.cpp),
[`Kconfig.projbuild`](../xiaozhi-esp32/main/Kconfig.projbuild)

- On boot the device **HTTP POSTs system-info JSON** to the OTA endpoint.
  - Default URL `https://api.tenclass.net/xiaozhi/ota/` (`Kconfig.projbuild:3-7`),
    overridable via NVS `wifi/ota_url` (`ota.cc:46-53`).
  - Body = MAC, UUID, chip info, app version, board, partition table
    (`board.cc:70-178`, `GetSystemInfoJson`).
  - Identity headers: `Device-Id`=MAC, `Client-Id`=UUID, `Activation-Version`
    (`ota.cc:55-72`).
- The **single JSON response IS the configuration** (`ota.cc:116-241`). It may contain:
  - `websocket{ url, token, version }`  → written to NVS namespace `websocket`
  - `mqtt{ endpoint, client_id, username, password, publish_topic, keepalive }` → NVS `mqtt`
  - `firmware{ version, url, force }`  → the actual OTA image
  - `server_time{}` (sets clock) and `activation{ message, code, challenge, timeout_ms }`
- **Activation**: HMAC-SHA256 over the server `challenge` (eFuse key), POSTed to
  `<ota_url>activate` — `200`=activated, `202`=pending (`ota.cc:421-492`).

This endpoint behaves like a REST provisioning/OTA API: it decides **which transport the
device uses next and supplies its URL + auth token**.

### 1b. Runtime transport — selectable WebSocket **or** MQTT+UDP

Selection happens in `Application::InitializeProtocol`
([`application.cc:473-487`](../xiaozhi-esp32/main/application.cc)):
**MQTT if an `mqtt` section was provisioned, else WebSocket, else MQTT fallback.**
The base [`Protocol`](../xiaozhi-esp32/main/protocols/protocol.h) class is
transport-agnostic (pure-virtual `Start / OpenAudioChannel / CloseAudioChannel /
IsAudioChannelOpened / SendAudio / SendText`, `protocol.h:66-92`).

#### WebSocket transport — [`websocket_protocol.cc`](../xiaozhi-esp32/main/protocols/websocket_protocol.cc)

One WebSocket connection carrying **two logical channels**:

- **TEXT frames = JSON control messages** (every inbound text must have a string `"type"`;
  `hello` is consumed internally, everything else → `on_incoming_json_`) — `:112-164`.
- **BINARY frames = Opus audio**, framed by `version_` (default `1`):
  - **v1**: raw Opus, no header (`:55-57` / `:139-146`)
  - **v2**: `BinaryProtocol2 { u16 version; u16 type; u32 reserved; u32 timestamp;
    u32 payload_size; u8 payload[] }`, network byte order; `type` 0=OPUS/1=JSON;
    `timestamp` (ms) for server-side AEC — `protocol.h:17-24`, `:33-44` / `:115-127`
  - **v3**: `BinaryProtocol3 { u8 type; u8 reserved; u16 payload_size; u8 payload[] }`,
    no timestamp — `protocol.h:26-31`, `:45-54` / `:128-138`

Connection is **lazy** — `Start()` is a no-op; the real connect is inside
`OpenAudioChannel()` (`:83-200`):
1. Load `url` / `token` / `version` from NVS `websocket` (`:84-90`).
2. Create WebSocket, set headers: `Authorization: Bearer <token>`, `Protocol-Version`,
   `Device-Id`=MAC, `Client-Id`=UUID (`:101-110`).
3. Connect, send client `hello`, then **block ≤10s** for the server `hello`
   (FreeRTOS event bit) — `:176-194`.
4. Server `hello` supplies `session_id` and downstream `audio_params` (`:228-254`).

#### MQTT+UDP transport — [`mqtt_protocol.cc`](../xiaozhi-esp32/main/protocols/mqtt_protocol.cc)

Control and audio are **split across two sockets**:

- **Control JSON over MQTT** (TLS, default port `8883`; endpoint `host:port` parsed from
  NVS `mqtt/endpoint`; publishes to `publish_topic`) — `:59-164`.
- The client `hello` requests `"transport":"udp"`; the server `hello` returns a
  `udp{ server, port, key, nonce }` block (`:297-366`).
- **Audio over a raw UDP socket, AES-128-CTR encrypted**. Each packet =
  16-byte nonce header `|type|flags|payload_len|ssrc|timestamp|sequence|` + encrypted
  Opus, with replay/sequence checking (`:166-295`). `key`/`nonce` are hex-decoded from the
  server hello (`:360-362`).

#### Audio format (both transports)

Client always announces **upstream `opus / 16000 Hz / mono`**
(`websocket_protocol.cc:215-220`, `mqtt_protocol.cc:309-313`). Downstream rate comes from
the server `hello` `audio_params` (defaults **24000 Hz / 60 ms**, `protocol.h:86-87`).

### 1c. Control-message JSON schema

Built as strings in [`protocol.cc`](../xiaozhi-esp32/main/protocols/protocol.cc); dispatched
inbound in [`application.cc`](../xiaozhi-esp32/main/application.cc) (`OnIncomingJson`,
`:521-599`).

**Client → server:**
- `{ session_id, type:"listen", state:"start", mode:"realtime"|"auto"|"manual" }` (`protocol.cc:57-69`)
- `{ session_id, type:"listen", state:"stop" }` (`:71-74`)
- `{ session_id, type:"listen", state:"detect", text:<wake_word> }` (`:51-55`)
- `{ session_id, type:"abort", reason?:"wake_word_detected" }` (`:42-49`)
- `{ session_id, type:"mcp", payload:<json-rpc> }` (`:76-79`)
- `hello` (client) — `type`, `version`, `features{ aec?, mcp }`, `transport`, `audio_params{}`

**Server → client:** `tts` (`state: start|stop|sentence_start`, `text`), `stt` (`text`),
`llm` (`emotion`), `mcp` (`payload`), plus `system` / `alert`.
**Note:** there is **no TTS sender** — TTS text arrives as JSON and its audio arrives on the
binary channel.

### 1d. MCP control layer (device-side tools)

Source: [`mcp_server.cc`](../xiaozhi-esp32/main/mcp_server.cc),
[`mcp_server.h`](../xiaozhi-esp32/main/mcp_server.h),
[`hal_mcp.cpp`](../main/hal/hal_mcp.cpp)

- The device runs an `McpServer` speaking **JSON-RPC 2.0 (MCP spec 2024-11-05)**.
- **Not a separate connection** — each JSON-RPC message is the `payload` of an
  `{ "type":"mcp" }` control frame on the channel above (`mcp_server.cc:353-563`,
  `protocol.cc:76-79`, dispatched at `application.cc:565-569`).
- Handles `initialize` / `tools/list` (paginated) / `tools/call`.
- Core tools = `self.*` (device status, volume, brightness, camera, reboot, OTA)
  (`mcp_server.cc:33-301`).
- **StackChan registers its own robot tools** in `hal_mcp.cpp`:
  `self.robot.set_head_angles`, `self.robot.get_head_angles`, `self.robot.set_led_color`,
  `self.robot.create_reminder` / `get_reminders` / `stop_reminder`, and
  `self.robot.go_to_sleep` ("stop listening" / "go away": ends the conversation
  and returns the device to Idle standby via `Application::ReturnToIdle()`;
  the wake word or a tap wakes it again).
  This is how the LLM physically drives the StackChan.

---

## 2. StackChan "avatar / video-call" server (StackChan-specific)

Source: [`hal_ws_avatar.cpp`](../main/hal/hal_ws_avatar.cpp),
[`app_avatar/view/ws_call.cpp`](../main/apps/app_avatar/view/ws_call.cpp),
[`secret_logic.cpp`](../main/hal/utils/secret_logic/secret_logic.cpp)

A **second, unrelated WebSocket** to a self-hosted StackChan backend:

- Base URL `CONFIG_STACKCHAN_SERVER_URL`, default `http://47.113.125.164:12800`
  (`main/Kconfig.projbuild`, `secret_logic.cpp:11-18`); path
  `/stackChan/ws?deviceType=StackChan` (`hal_ws_avatar.cpp:66`).
- Auth header `Authorization: hi-stack-chan` — **hardcoded weak token**
  (`secret_logic.cpp:20-23`, `hal_ws_avatar.cpp:100,117`).
- Plain-text `hello`: `{"type":"hello","msg":"Hello from StackChan!"}` (`:124`).
- **Custom binary framing**: `[1-byte DataType][4-byte big-endian length][payload]`
  (`:453-476`). `DataType` enum (`:36-57`): `Opus=0x01`, `Jpeg=0x02`, `ControlAvatar=0x03`,
  `ControlMotion=0x04`, `StartCameraStream=0x05`, `StopCameraStream=0x06`,
  `TextMessage=0x07`, call signaling `RequestCall=0x09`/`DeclineCall=0x0A`/`AcceptCall=0x0B`/
  `EndCall=0x0C`, `Heartbeat Ping=0x10`/`Pong=0x11`, `VideoModeOn/Off=0x12/0x13`,
  `DanceSequence=0x14`, `StartAudioStream=0x18`/`StopAudioStream=0x19`.
- Drives avatar emotion/motion/dance, text chat, and **bidirectional JPEG video calling**
  (camera frames out, decoded video in) — `:168-173`, `:317-348`, `:378-419`.
- [`ws_call.cpp`](../main/apps/app_avatar/view/ws_call.cpp) is purely the LVGL incoming-call
  UI; the HAL emits the actual Accept/Decline/End packets.

This is the "StackChan World" app backend — **completely separate from the xiaozhi AI
server** in §1.

---

## 3. M5Stack EzData / UIFlow2 cloud

Source: [`hal_ezdata.cpp`](../main/hal/hal_ezdata.cpp)

- First **HTTPS POST** to `https://ezdata2.m5stack.com/api/v2/device/registerMac`
  (`{ deviceType:"CoreS3", mac }`) → returns a `deviceToken` (`:158-209`).
- Then **MQTT to `uiflow2.m5stack.com:1883`** (plain TCP), client id `ez{mac}ez`,
  username = token (`:227-257`).
- Pub `$ezdata/{token}/up`, sub `$ezdata/{token}/down` (`:236-237`); JSON messages keyed by
  an integer `requestType`/`cmd` enum (`CmdType`, `:26-50`). Used for servo-data sync and
  obtaining a pairing code (`DeviceGetMatchCode=112`).

---

## Quick "where do I look?" index

- **"Which transport is actually used?"** → `application.cc:473-487` (selection logic).
- **"How is the server URL/token obtained?"** → OTA response → NVS, `ota.cc:147-186`; read
  back in `websocket_protocol.cc:84-110` / `mqtt_protocol.cc:65-79`.
- **"Audio not playing / wrong sample rate"** → `hello` exchange + `audio_params`
  (`websocket_protocol.cc:203-254`, `mqtt_protocol.cc:297-366`); binary framing
  (`protocol.h:17-31`).
- **"Add a new device capability for the LLM"** → register an MCP tool in
  `hal_mcp.cpp` (pattern at `hal_mcp.cpp:42-70`).
- **"Avatar / video call / dance issues"** → `hal_ws_avatar.cpp` (the StackChan WS server),
  NOT the xiaozhi protocols.

---

### Security notes (flag before any real deployment)
- Avatar-server token `"hi-stack-chan"` is hardcoded and the default avatar/EzData hosts use
  plain `http://` / unencrypted MQTT (`secret_logic.cpp:20-23`, `hal_ezdata.cpp:257`).
- The xiaozhi AI path is the more hardened one (Bearer token from OTA, TLS MQTT on 8883,
  AES-CTR UDP audio).

---

*Generated from a source-verified pass over the protocol/HAL layers. If the cited line
numbers drift, search by the symbol names (they're stable): `OpenAudioChannel`,
`ParseServerHello`, `GetHelloMessage`, `InitializeProtocol`, `OnIncomingJson`,
`SendMcpMessage`, `sendPacket`, `registerMac`.*
