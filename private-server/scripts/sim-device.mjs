#!/usr/bin/env node
/**
 * Simulated StackChan device for the xiaozhi realtime backend.
 *
 * Drives private-server's /xiaozhi/v1/ WebSocket exactly the way the firmware
 * does (firmware/xiaozhi-esp32/main/protocols/websocket_protocol.cc):
 *
 *   1. connect (retry-poll for up to ~5s in case the server is still booting)
 *   2. send the client `hello` TEXT frame (features.mcp = true, like firmware)
 *   3. assert the server `hello` is valid: type="hello", transport="websocket",
 *      a non-empty session_id, and audio_params.sample_rate == 24000
 *   4. answer the server's MCP handshake the way the firmware's McpServer does
 *      (mcp_server.cc): reply to `initialize` (capturing capabilities.vision)
 *      and `tools/list` (advertising a fake self.camera.take_photo), and assert
 *      the server actually drives both — that is what provisions the camera and
 *      discovers device tools on real hardware.
 *   5. send `listen start` -> a couple of BINARY opus frames -> `listen stop`
 *      and assert the connection does NOT crash. With llama/whisper/tts down the
 *      server hits a provider error mid-turn; that is fine as long as the socket
 *      stays OPEN (and, best-effort, brackets its reply with tts start/stop).
 *
 * Exit 0 iff every critical check passes; non-zero otherwise. No hardware and no
 * local AI servers are required.
 *
 * Run: node scripts/sim-device.mjs   (or: npm run sim)
 */
import { WebSocket } from 'ws';

const URL = process.env.SIM_WS_URL ?? 'ws://127.0.0.1:12800/xiaozhi/v1/';
const CONNECT_DEADLINE_MS = 5_000; // retry-connect budget while server boots
const CONNECT_POLL_MS = 200; // gap between connection attempts
const HELLO_TIMEOUT_MS = 10_000; // device aborts if no server hello in 10s
const OBSERVE_MS = 3_000; // watch the socket after the listen turn

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[sim]', ...a);

/* ------------------------------- checks ---------------------------------- */

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: !!ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  return !!ok;
}

/* --------------------------- connect w/ retry ----------------------------- */

async function connectWithRetry() {
  const deadline = Date.now() + CONNECT_DEADLINE_MS;
  let attempt = 0;
  let lastReason = 'unknown';
  // The firmware's ws client sends the Host header WITHOUT the port
  // (esp-ml307 web_socket.cc:141-142) — mimic that, or bugs in the server's
  // host:port reconstruction (vision URL!) stay invisible here.
  const portlessHost = new globalThis.URL(URL.replace(/^ws/, 'http')).hostname;
  while (true) {
    attempt++;
    const ws = new WebSocket(URL, { headers: { Host: portlessHost } });
    const outcome = await new Promise((resolve) => {
      ws.on('error', () => {}); // guard: never let a raw 'error' throw
      ws.once('open', () => resolve('open'));
      ws.once('close', () => resolve('close'));
      ws.once('unexpected-response', (_req, res) =>
        resolve(`http-${res.statusCode}`),
      );
    });
    if (outcome === 'open') {
      log(`connected to ${URL} on attempt ${attempt}`);
      return ws;
    }
    lastReason = outcome;
    try {
      ws.terminate();
    } catch {}
    if (Date.now() >= deadline) {
      throw new Error(
        `could not connect to ${URL} within ${CONNECT_DEADLINE_MS}ms ` +
          `(${attempt} attempts, last=${lastReason})`,
      );
    }
    await delay(CONNECT_POLL_MS);
  }
}

/* ----------------------- inbound frame bookkeeping ------------------------ */

/** All frames the server sent us, newest last. */
const inbox = [];
const textWaiters = [];
const pendingText = [];

function wireInbox(ws) {
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      inbox.push({ kind: 'binary', bytes: data.length });
      return;
    }
    const text = data.toString('utf8');
    let obj = null;
    try {
      obj = JSON.parse(text);
    } catch {}
    const frame = { kind: 'text', text, obj };
    inbox.push(frame);
    if (obj?.type === 'mcp') {
      handleMcp(ws, obj.payload);
      return; // MCP frames are answered here, not queued for the main flow
    }
    const w = textWaiters.shift();
    if (w) w(frame);
    else pendingText.push(frame);
  });
}

/* ------------------------- MCP device emulation --------------------------- */

/**
 * Answer the server's MCP JSON-RPC requests the way the firmware's McpServer
 * does (firmware/xiaozhi-esp32/main/mcp_server.cc ParseMessage): numeric-id
 * requests for initialize / tools/list / tools/call, replies wrapped back into
 * {"type":"mcp","payload":...} frames.
 */
const mcpState = { visionUrl: null, visionToken: null, toolsListed: false, calls: [] };

const SIM_DEVICE_TOOLS = [
  {
    name: 'self.camera.take_photo',
    description:
      'Always remember you have a camera. If the user asks you to see something, ' +
      'use this tool to take a photo and then explain it.',
    inputSchema: {
      type: 'object',
      properties: { question: { type: 'string' } },
      required: ['question'],
    },
  },
  {
    name: 'self.robot.set_head_angles',
    description: 'Move the robot head to the given yaw/pitch angles.',
    inputSchema: {
      type: 'object',
      properties: { yaw: { type: 'integer' }, pitch: { type: 'integer' } },
    },
  },
];

function handleMcp(ws, payload) {
  const { id, method, params } = payload ?? {};
  if (typeof id !== 'number' || typeof method !== 'string') return;
  const reply = (result) =>
    ws.send(JSON.stringify({ type: 'mcp', payload: { jsonrpc: '2.0', id, result } }));
  if (method === 'initialize') {
    mcpState.visionUrl = params?.capabilities?.vision?.url ?? null;
    mcpState.visionToken = params?.capabilities?.vision?.token ?? null;
    log(`mcp initialize (vision.url=${mcpState.visionUrl})`);
    reply({
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'sim-device', version: '1.0.0' },
    });
  } else if (method === 'tools/list') {
    mcpState.toolsListed = true;
    log('mcp tools/list');
    reply({ tools: SIM_DEVICE_TOOLS });
  } else if (method === 'tools/call') {
    mcpState.calls.push(params?.name);
    log(`mcp tools/call ${params?.name}`);
    reply({
      content: [{ type: 'text', text: '{"success":true,"result":"(sim) ok"}' }],
      isError: false,
    });
  } else {
    ws.send(
      JSON.stringify({
        type: 'mcp',
        payload: { jsonrpc: '2.0', id, error: { message: `Method not implemented: ${method}` } },
      }),
    );
  }
}

/** Resolve with the next server TEXT frame, or reject on timeout. */
function nextTextFrame(timeoutMs) {
  if (pendingText.length) return Promise.resolve(pendingText.shift());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = textWaiters.indexOf(wrapped);
      if (i >= 0) textWaiters.splice(i, 1);
      reject(new Error(`timed out after ${timeoutMs}ms waiting for a text frame`));
    }, timeoutMs);
    const wrapped = (frame) => {
      clearTimeout(timer);
      resolve(frame);
    };
    textWaiters.push(wrapped);
  });
}

/* ------------------------------ audio frames ------------------------------ */

/**
 * A couple of tiny BINARY upstream frames. We deliberately do NOT pull in a real
 * opus encoder: the point of this smoke test is only to prove the server
 * tolerates upstream audio + a provider outage without dropping the socket, and
 * loading the native @discordjs/opus addon via ESM `import()` is flaky in a bare
 * script (the server itself uses it fine via CommonJS `require`). Each buffer
 * starts with a valid opus TOC byte, so the server will typically decode it and
 * attempt a full STT->LLM->TTS turn; if it can't, it just logs a decode warning.
 * Either way the connection must stay up.
 */
function makeUpstreamFrames() {
  return [Buffer.from([0xfc, 0x00, 0x00]), Buffer.from([0xfc, 0x00])];
}

/* --------------------------------- main ----------------------------------- */

async function main() {
  log(`target ${URL}`);

  // 1. connect (retry while the server may still be starting)
  let ws;
  try {
    ws = await connectWithRetry();
    check('connect (<=5s, retry-poll)', true, `readyState=${ws.readyState}`);
  } catch (e) {
    check('connect (<=5s, retry-poll)', false, e.message);
    return finish(ws);
  }
  wireInbox(ws);
  ws.on('close', (code) => log(`socket closed by server (code=${code})`));

  // 2. send the client hello exactly as the firmware does
  const clientHello = {
    type: 'hello',
    version: 1,
    transport: 'websocket',
    features: { mcp: true },
    audio_params: {
      format: 'opus',
      sample_rate: 16000,
      channels: 1,
      frame_duration: 60,
    },
  };
  ws.send(JSON.stringify(clientHello));
  log('sent client hello');

  // 3. assert a valid server hello
  let hello;
  try {
    const frame = await nextTextFrame(HELLO_TIMEOUT_MS);
    hello = frame.obj ?? {};
    log('server hello:', frame.text);
  } catch (e) {
    check('server hello received (<=10s)', false, e.message);
    return finish(ws);
  }
  check('server hello received (<=10s)', true);
  check('hello.type == "hello"', hello.type === 'hello', `got ${JSON.stringify(hello.type)}`);
  check(
    'hello.transport == "websocket"',
    hello.transport === 'websocket',
    `got ${JSON.stringify(hello.transport)}`,
  );
  const sid = hello.session_id;
  check(
    'hello.session_id present',
    typeof sid === 'string' && sid.length > 0,
    `got ${JSON.stringify(sid)}`,
  );
  check(
    'hello.audio_params.sample_rate == 24000',
    hello?.audio_params?.sample_rate === 24000,
    `got ${JSON.stringify(hello?.audio_params?.sample_rate)}`,
  );
  // Informational (not fatal): downstream frame duration.
  log(`hello.audio_params.frame_duration = ${JSON.stringify(hello?.audio_params?.frame_duration)}`);

  // 4. the server must drive the MCP handshake (vision provisioning + tool
  // discovery) right after hello; give it a moment to complete.
  const mcpDeadline = Date.now() + 3_000;
  while (Date.now() < mcpDeadline && !mcpState.toolsListed) await delay(50);
  check(
    'mcp initialize received with capabilities.vision.url',
    typeof mcpState.visionUrl === 'string' &&
      mcpState.visionUrl.includes('/xiaozhi/vision/explain'),
    `url=${JSON.stringify(mcpState.visionUrl)}`,
  );
  // The device dials the URL literally: with the port missing it goes to :80
  // (the firmware ws client's Host header has no port to echo back).
  const wsPort = new globalThis.URL(URL.replace(/^ws/, 'http')).port || '80';
  check(
    `vision url carries the server port :${wsPort}`,
    typeof mcpState.visionUrl === 'string' &&
      new globalThis.URL(mcpState.visionUrl).port === wsPort,
    `url=${JSON.stringify(mcpState.visionUrl)}`,
  );
  check(
    'mcp initialize carries the bearer token',
    typeof mcpState.visionToken === 'string' && mcpState.visionToken.length > 0,
  );
  check('mcp tools/list received', mcpState.toolsListed);

  // 5. drive one listen turn and make sure the connection survives it
  const frames = makeUpstreamFrames();
  log(`using ${frames.length} tiny upstream audio frames`);

  const inboxMarkBefore = inbox.length;
  ws.send(JSON.stringify({ session_id: sid, type: 'listen', state: 'start', mode: 'manual' }));
  log('sent listen start');
  for (const f of frames) ws.send(f, { binary: true });
  log(`sent ${frames.length} binary audio frames`);
  ws.send(JSON.stringify({ session_id: sid, type: 'listen', state: 'stop' }));
  log('sent listen stop');

  // Watch the socket: it must stay OPEN. Break early if we see a tts stop
  // (turn completed/errored cleanly) or the socket drops (failure).
  const deadline = Date.now() + OBSERVE_MS;
  let sawTtsStop = false;
  while (Date.now() < deadline) {
    if (ws.readyState !== WebSocket.OPEN) break;
    if (inbox.some((f) => f.obj?.type === 'tts' && f.obj?.state === 'stop')) {
      sawTtsStop = true;
      break;
    }
    await delay(100);
  }

  const stayedUp = ws.readyState === WebSocket.OPEN;
  const after = inbox.slice(inboxMarkBefore);
  const ttsStates = after.filter((f) => f.obj?.type === 'tts').map((f) => f.obj.state);
  const otherTypes = [...new Set(after.filter((f) => f.kind === 'text').map((f) => f.obj?.type))];
  const binaryCount = after.filter((f) => f.kind === 'binary').length;
  check(
    'connection survives listen turn (provider error tolerated)',
    stayedUp,
    `readyState=${ws.readyState}, tts=${JSON.stringify(ttsStates)}, ` +
      `textTypes=${JSON.stringify(otherTypes)}, binaryFrames=${binaryCount}`,
  );
  log(
    sawTtsStop
      ? 'observed a tts stop -> server ran the turn and closed its speaking bracket after the provider error'
      : 'no tts stop within the window (expected when STT retry/backoff outlasts it); socket remained up',
  );

  return finish(ws);
}

function finish(ws) {
  try {
    ws?.close();
  } catch {}
  const failed = checks.filter((c) => !c.ok);
  log('----------------------------------------');
  log(`RESULT: ${failed.length === 0 ? 'PASS' : 'FAIL'} (${checks.length - failed.length}/${checks.length} checks passed)`);
  if (failed.length) log('failed:', failed.map((c) => c.name).join('; '));
  // Give the close frame a tick to flush, then exit deterministically.
  setTimeout(() => process.exit(failed.length === 0 ? 0 : 1), 150);
}

main().catch((e) => {
  check('unexpected error', false, e?.stack ?? String(e));
  finish();
});
