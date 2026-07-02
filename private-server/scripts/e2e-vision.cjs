'use strict';
/*
 * End-to-end CAMERA VISION test for the StackChan private-server.
 *
 * Emulates the firmware device — including its MCP server and camera — and
 * exercises the whole "What can you see" chain in one real turn:
 *   hello -> MCP initialize (server hands us the vision URL+token)
 *         -> MCP tools/list (we advertise self.camera.take_photo)
 *         -> listen start -> upstream Opus ("what can you see?") -> listen stop
 *         -> STT -> LLM decides to call the camera tool -> MCP tools/call
 *         -> we POST a test JPEG (white circle on red) to the vision URL the
 *            exact way StackChanCamera::Explain does (chunked multipart,
 *            question + file fields, Bearer token, Device-Id header)
 *         -> vision model describes the photo -> LLM speaks the description
 *         -> downstream Opus -> tts stop
 * The reply audio is then re-transcribed via whisper as a round-trip check.
 *
 * Prerequisites — all must be running (see .env / docker-compose.yml):
 *   - private-server          (npm run start:prod)      ws://127.0.0.1:12800
 *   - llama.cpp with a MULTIMODAL, TOOL-CAPABLE model   http://127.0.0.1:10000/v1
 *   - whisper                                           http://127.0.0.1:10010/inference
 *   - Kokoro (TTS)                                      http://127.0.0.1:50060/v1
 *
 * Usage:  npm run e2e:vision
 * Env overrides: WS_URL, WHISPER_URL, WAV_PATH, E2E_PROMPT, TEST_IMAGE (a JPEG).
 * Exit code 0 = PASS, non-zero = FAIL.
 */
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { WebSocket } = require('ws');
const OpusScript = require('opusscript');
const { ensureInputWav, parseWav, pcm16ToWav } = require('./lib/wav.cjs');

const WS_URL = process.env.WS_URL || 'ws://127.0.0.1:12800/xiaozhi/v1/';
const WHISPER_URL = process.env.WHISPER_URL || 'http://127.0.0.1:10010/inference';
const PROMPT =
  process.env.E2E_PROMPT || 'Stack Chan, look with your camera. What can you see right now?';
const WAV_PATH =
  process.env.WAV_PATH || path.join(os.tmpdir(), 'stackchan-e2e-vision-input.wav');
const REPLY_WAV =
  process.env.REPLY_WAV || path.join(os.tmpdir(), 'stackchan-e2e-vision-reply.wav');
const TEST_IMAGE = process.env.TEST_IMAGE || path.join(os.tmpdir(), 'stackchan-e2e-vision.jpg');
const SR_IN = 16000, SR_OUT = 24000, FRAME_MS = 60;
const FRAME_SAMPLES_IN = (SR_IN * FRAME_MS) / 1000; // 960
const FRAME_BYTES_IN = FRAME_SAMPLES_IN * 2; // 1920

/**
 * Make the "camera photo": a white circle on a red background — unambiguous
 * for any VLM. Built as a BMP in pure JS, converted to JPEG via macOS sips
 * (same platform-tool approach as the audio above). TEST_IMAGE overrides.
 */
function ensureTestJpeg() {
  if (fs.existsSync(TEST_IMAGE)) return;
  const w = 128, h = 128;
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(w * 3);
    for (let x = 0; x < w; x++) {
      const dx = x - 64, dy = y - 64;
      const inside = dx * dx + dy * dy < 30 * 30;
      row[x * 3] = inside ? 0xff : 0x00; // B
      row[x * 3 + 1] = inside ? 0xff : 0x00; // G
      row[x * 3 + 2] = inside ? 0xff : 0xd0; // R
    }
    rows.push(row);
  }
  const pixels = Buffer.concat(rows.reverse()); // BMP is bottom-up
  const header = Buffer.alloc(54);
  header.write('BM', 0);
  header.writeUInt32LE(54 + pixels.length, 2);
  header.writeUInt32LE(54, 10); // pixel data offset
  header.writeUInt32LE(40, 14); // DIB size
  header.writeInt32LE(w, 18);
  header.writeInt32LE(h, 22);
  header.writeUInt16LE(1, 26); // planes
  header.writeUInt16LE(24, 28); // bpp
  header.writeUInt32LE(pixels.length, 34);
  const bmp = TEST_IMAGE.replace(/\.jpe?g$/, '') + '.bmp';
  fs.writeFileSync(bmp, Buffer.concat([header, pixels]));
  execFileSync('sips', ['-s', 'format', 'jpeg', bmp, '--out', TEST_IMAGE], { stdio: 'ignore' });
}

/**
 * Upload the photo to the vision URL EXACTLY like StackChanCamera::Explain
 * (firmware/main/hal/board/stackchan_camera.cc:1027): chunked transfer (no
 * Content-Length), multipart fields `question` then `file`, headers Device-Id /
 * Client-Id / Authorization: Bearer. Resolves with {status, body}.
 */
function uploadPhotoLikeFirmware(visionUrl, token, question, jpeg) {
  const boundary = '----ESP32_CAMERA_BOUNDARY';
  const parts = [
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="question"\r\n\r\n${question}\r\n`,
    ),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="camera.jpg"\r\n` +
        `Content-Type: image/jpeg\r\n\r\n`,
    ),
    jpeg,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ];
  return new Promise((resolve, reject) => {
    const req = http.request(
      visionUrl,
      {
        method: 'POST',
        headers: {
          'Device-Id': 'aa:bb:cc:dd:ee:ff',
          'Client-Id': 'e2e-vision-sim',
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          // no Content-Length -> Node sends Transfer-Encoding: chunked
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('error', reject);
    for (const part of parts) req.write(part);
    req.end();
  });
}

async function main() {
  ensureInputWav(WAV_PATH, PROMPT);
  ensureTestJpeg();
  const jpeg = fs.readFileSync(TEST_IMAGE);

  // Encode the 16k WAV into upstream Opus frames.
  const wav = fs.readFileSync(WAV_PATH);
  const meta = parseWav(wav);
  if (meta.sampleRate !== SR_IN || meta.channels !== 1)
    throw new Error(`expected 16k mono, got ${meta.sampleRate}Hz ${meta.channels}ch`);
  const pcm = wav.subarray(meta.offset, meta.offset + meta.length);
  const enc = new OpusScript(SR_IN, 1, OpusScript.Application.AUDIO);
  const frames = [];
  for (let i = 0; i + FRAME_BYTES_IN <= pcm.length; i += FRAME_BYTES_IN)
    frames.push(enc.encode(pcm.subarray(i, i + FRAME_BYTES_IN), FRAME_SAMPLES_IN));
  console.log(`[sim] "${PROMPT}"`);
  console.log(`[sim] photo: ${TEST_IMAGE} (${jpeg.length} bytes, white circle on red)`);

  // Drive one turn over the WS, answering MCP as the firmware would.
  const st = {
    hello: null, stt: null, sentences: [], ttsStart: false, ttsStop: false, opus: [],
    visionUrl: null, visionToken: null, toolsListed: false, toolCalls: [],
    visionStatus: null, visionBody: null,
  };
  // Portless Host header, like the firmware's ws client (web_socket.cc:141):
  // the vision URL we get back must still carry the right port or the photo
  // upload below dials port 80 exactly like the real camera would.
  const portlessHost = new URL(WS_URL.replace(/^ws/, 'http')).hostname;
  const ws = new WebSocket(WS_URL, { headers: { Host: portlessHost } });

  const mcpReply = (id, result) =>
    ws.send(JSON.stringify({ type: 'mcp', payload: { jsonrpc: '2.0', id, result } }));
  async function handleMcp(payload) {
    const { id, method, params } = payload ?? {};
    if (typeof id !== 'number') return;
    if (method === 'initialize') {
      st.visionUrl = params?.capabilities?.vision?.url ?? null;
      st.visionToken = params?.capabilities?.vision?.token ?? null;
      console.log(`[sim] mcp initialize -> vision ${st.visionUrl}`);
      mcpReply(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'e2e-vision-sim', version: '1.0.0' },
      });
    } else if (method === 'tools/list') {
      st.toolsListed = true;
      console.log('[sim] mcp tools/list -> advertising self.camera.take_photo');
      mcpReply(id, {
        tools: [
          {
            name: 'self.camera.take_photo',
            description:
              'Always remember you have a camera. If the user asks you to see something, ' +
              'use this tool to take a photo and then explain it.\n' +
              'Args:\n  `question`: The question that you want to ask about the photo.\n' +
              'Return:\n  A JSON object that provides the photo information.',
            inputSchema: {
              type: 'object',
              properties: { question: { type: 'string' } },
              required: ['question'],
            },
          },
        ],
      });
    } else if (method === 'tools/call' && params?.name === 'self.camera.take_photo') {
      const question = params?.arguments?.question ?? 'What do you see?';
      st.toolCalls.push(question);
      console.log(`[sim] mcp tools/call take_photo("${question}") -> uploading photo`);
      try {
        const { status, body } = await uploadPhotoLikeFirmware(
          st.visionUrl, st.visionToken, question, jpeg,
        );
        st.visionStatus = status;
        st.visionBody = body;
        console.log(`[sim] vision endpoint: HTTP ${status} ${body}`);
        if (status !== 200) throw new Error(`explain URL returned ${status}`);
        // The firmware returns the response body VERBATIM as the tool text.
        mcpReply(id, { content: [{ type: 'text', text: body }], isError: false });
      } catch (e) {
        ws.send(JSON.stringify({
          type: 'mcp', payload: { jsonrpc: '2.0', id, error: { message: e.message } },
        }));
      }
    } else {
      ws.send(JSON.stringify({
        type: 'mcp',
        payload: { jsonrpc: '2.0', id, error: { message: `Method not implemented: ${method}` } },
      }));
    }
  }

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for tts stop (180s)')), 180000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', version: 1, transport: 'websocket', features: { mcp: true },
        audio_params: { format: 'opus', sample_rate: 16000, channels: 1, frame_duration: 60 } }));
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) { st.opus.push(Buffer.from(data)); return; }
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === 'hello') {
        st.hello = m;
        ws.send(JSON.stringify({ type: 'listen', state: 'start', mode: 'manual' }));
        for (const f of frames) ws.send(f, { binary: true });
        ws.send(JSON.stringify({ type: 'listen', state: 'stop' }));
      } else if (m.type === 'mcp') void handleMcp(m.payload);
      else if (m.type === 'stt') st.stt = m.text;
      else if (m.type === 'tts') {
        if (m.state === 'start') st.ttsStart = true;
        else if (m.state === 'sentence_start') st.sentences.push(m.text);
        else if (m.state === 'stop') { st.ttsStop = true; clearTimeout(timer); resolve(); }
      }
    });
    ws.on('error', reject);
    ws.on('close', () => { if (!st.ttsStop) { clearTimeout(timer); reject(new Error('socket closed before tts stop')); } });
  });
  ws.close();

  // Decode the reply audio and re-transcribe it (round-trip proof).
  const dec = new OpusScript(SR_OUT, 1, OpusScript.Application.AUDIO);
  const outPcm = Buffer.concat(st.opus.map((p) => dec.decode(p)));
  const durSec = outPcm.length / 2 / SR_OUT;
  fs.writeFileSync(REPLY_WAV, pcm16ToWav(outPcm, SR_OUT));
  let heard = '(not attempted)';
  if (outPcm.length) {
    try {
      const fd = new FormData();
      fd.append('file', new Blob([new Uint8Array(pcm16ToWav(outPcm, SR_OUT))], { type: 'audio/wav' }), 'reply.wav');
      fd.append('response_format', 'json');
      const r = await fetch(WHISPER_URL, { method: 'POST', body: fd });
      heard = (await r.json()).text;
    } catch (e) { heard = 'ERR ' + e.message; }
  }

  let visionResult = null;
  try { visionResult = JSON.parse(st.visionBody ?? 'null'); } catch {}

  console.log('\n================ E2E VISION RESULT ================');
  console.log('STT (user said):', JSON.stringify(st.stt));
  console.log('tool calls     :', JSON.stringify(st.toolCalls));
  console.log('vision response:', st.visionBody);
  console.log('reply sentences:', JSON.stringify(st.sentences));
  console.log('downstream opus:', st.opus.length, 'frames ->', durSec.toFixed(2) + 's ->', REPLY_WAV);
  console.log('whisper reheard:', JSON.stringify(heard));
  const spoken = st.sentences.join(' ').toLowerCase();
  const checks = {
    'mcp initialize with vision url': !!(st.visionUrl && st.visionToken),
    'tools/list answered': st.toolsListed,
    'LLM called self.camera.take_photo': st.toolCalls.length > 0,
    'vision endpoint success:true': !!(visionResult && visionResult.success && visionResult.result),
    'tts start+stop': st.ttsStart && st.ttsStop,
    'got downstream audio': st.opus.length > 0 && durSec > 0.2,
  };
  // Soft signal, not a hard check (phrasing is up to two models): does the
  // spoken reply reference what is actually in the photo?
  console.log('reply mentions photo content:', /red|circle|white|round|dot/.test(spoken));
  console.log('checks         :', JSON.stringify(checks));
  const ok = Object.values(checks).every(Boolean);
  console.log(ok ? '\nE2E VISION: PASS ✅' : '\nE2E VISION: FAIL ❌');
  process.exitCode = ok ? 0 : 1;
}
main().catch((e) => { console.error('E2E ERROR:', e.stack || e.message); process.exitCode = 1; });
