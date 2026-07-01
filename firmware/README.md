
## Build

### Fetch Dependencies

Vendored dependencies (`components/*`, `xiaozhi-esp32`) are git submodules. From the repository root:

```bash
just setup
```

### Tool Chains

[ESP-IDF v5.5.4](https://docs.espressif.com/projects/esp-idf/en/v5.5.4/esp32s3/index.html)

### Build

From the repository root:

```bash
just build
```

This first generates the git-ignored sdkconfig overlay from the repo-root `.env`
(copy `.env.example` and set `PRIVATE_SERVER_URL`), then builds the firmware.

### Host-side tests

The motion coordinate helpers can be tested without ESP-IDF hardware:

```bash
cmake -S tests -B build-host-tests
cmake --build build-host-tests
ctest --test-dir build-host-tests --output-on-failure
```

### Flash

From the repository root:

```bash
just flash
```
