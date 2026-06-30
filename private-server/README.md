# StackChan private-server

A local **NestJS** server that takes over the role of the StackChan
avatar/app backend (the self-hosted "StackChan World" server, normally at
`http://47.113.125.164:12800`). It implements **dummy versions of every
endpoint and WebSocket message the StackChan firmware needs to function**, so
you can build and flash the firmware and have it talk to an instance running on
your own machine.

> Scope: this replaces **only** the StackChan avatar/app backend (backend #2 in
> [`firmware/docs/server-api-architecture.md`](../firmware/docs/server-api-architecture.md)).
> It does **not** replace the xiaozhi AI server (`api.tenclass.net`), the M5Stack
> EzData/UIFlow2 cloud, or the OTA cloud — those remain pointed at their defaults.

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
