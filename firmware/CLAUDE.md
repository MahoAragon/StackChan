# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

StackChan firmware: an **ESP-IDF** application (M5Stack StackChan robot) layered on top of a
**vendored copy of [`xiaozhi-esp32`](xiaozhi-esp32/)** (the AI-assistant base). StackChan-specific
code lives in [`main/`](main/) (apps, HAL, avatar/motion); the AI/voice/protocol base lives in
[`xiaozhi-esp32/main/`](xiaozhi-esp32/main/). Most reusable components are vendored under
`components/` and `managed_components/`.

## Reference docs

- **Server / API / network / protocol questions → read
  [`docs/server-api-architecture.md`](docs/server-api-architecture.md) first.**
  It documents how the firmware communicates with its **three** backends (the xiaozhi AI server
  over WebSocket *or* MQTT+UDP, the HTTP OTA/provisioning endpoint, the StackChan avatar/video-call
  WebSocket server, and the M5Stack EzData MQTT cloud), including message framing, the JSON control
  schema, the tunneled MCP layer, auth, and a "where do I look?" index with `file:line` pointers.
  Consult it whenever debugging or extending anything involving servers, transports, audio
  streaming, the `hello` handshake, MCP tools, OTA/activation, or device pairing.

## Conventions

- C/C++ formatted via [`.clang-format`](.clang-format).
- Don't hand-edit `components/` or `managed_components/` (vendored / managed deps).
- Build is ESP-IDF / CMake ([`CMakeLists.txt`](CMakeLists.txt), `sdkconfig`).
