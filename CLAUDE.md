# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Components

- [`firmware`](./firmware) - StackChan firmware: an **ESP-IDF** application (M5Stack StackChan robot) layered on top of a
**vendored copy of [`xiaozhi-esp32`](xiaozhi-esp32/)** (the AI-assistant base).
- [`private-server`](./private-server) - NestJS based private server for StackChan. Any BE changes should be done here.
- [`server`](./server) - Reference server code of the original StackChan service. Shouldn't be modified or run, only
used as a reference.

## Tasks

Use `just` to execute common tasks. Refer to [`justfile`](./justfile) for available commands. 
