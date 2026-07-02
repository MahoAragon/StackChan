'use strict';
/*
 * End-to-end conversation test for the StackChan private-server.
 *
 * Emulates the firmware device over the xiaozhi WS protocol and exercises all
 * three backends in one real turn:
 *   hello -> listen start -> upstream Opus (16k) -> listen stop
 *          -> STT (whisper) -> LLM (llama.cpp) -> TTS (Kokoro)
 *          -> downstream Opus (24k) -> tts stop
 * It then decodes the reply audio and re-transcribes it via whisper as a
 * round-trip sanity check.
 *
 * Prerequisites — all must be running (see .env / docker-compose.yml):
 *   - private-server         (npm run start:prod)      ws://127.0.0.1:12800
 *   - llama.cpp  (LLM)       http://127.0.0.1:10000/v1
 *   - whisper    (STT)       http://127.0.0.1:10010/inference
 *   - Kokoro     (TTS)       http://127.0.0.1:50060/v1
 *
 * Usage:  npm run e2e
 * Env overrides: WS_URL, WHISPER_URL, WAV_PATH (16k mono WAV), E2E_PROMPT.
 * Exit code 0 = PASS, non-zero = FAIL.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocket } = require('ws');
const OpusScript = require('opusscript'); // pure-WASM opus (matches server codec)
const { ensureInputWav, parseWav, pcm16ToWav } = require('./lib/wav.cjs');

const WS_URL = process.env.WS_URL || 'ws://127.0.0.1:12800/xiaozhi/v1/';
const WHISPER_URL = process.env.WHISPER_URL || 'http://127.0.0.1:10010/inference';
const PROMPT =
  process.env.E2E_PROMPT ||
  'Hello Stack Chan. What is your name, and what can you help me with?';
const WAV_PATH = process.env.WAV_PATH || path.join(os.tmpdir(), 'stackchan-e2e-input.wav');
const REPLY_WAV = process.env.REPLY_WAV || path.join(os.tmpdir(), 'stackchan-e2e-reply.wav');
const SR_IN = 16000, SR_OUT = 24000, FRAME_MS = 60;
const FRAME_SAMPLES_IN = (SR_IN * FRAME_MS) / 1000; // 960
const FRAME_BYTES_IN = FRAME_SAMPLES_IN * 2; // 1920

async function main() {
  ensureInputWav(WAV_PATH, PROMPT);

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
  console.log(`[sim] upstream: ${(pcm.length / 2 / SR_IN).toFixed(2)}s -> ${frames.length} opus frames`);

  // Drive one turn over the WS.
  const st = { hello: null, stt: null, llm: null, sentences: [], ttsStart: false, ttsStop: false, opus: [] };
  const ws = new WebSocket(WS_URL);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for tts stop (120s)')), 120000);
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
      } else if (m.type === 'stt') st.stt = m.text;
      else if (m.type === 'llm') st.llm = m.emotion;
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

  console.log('\n================ E2E RESULT ================');
  console.log('server hello   :', JSON.stringify(st.hello));
  console.log('STT (user said):', JSON.stringify(st.stt));
  console.log('LLM emotion    :', st.llm);
  console.log('reply sentences:', JSON.stringify(st.sentences));
  console.log('downstream opus:', st.opus.length, 'frames ->', durSec.toFixed(2) + 's ->', REPLY_WAV);
  console.log('whisper reheard:', JSON.stringify(heard));
  const checks = {
    'hello.transport==websocket': st.hello && st.hello.transport === 'websocket',
    'hello.sample_rate==24000': st.hello && st.hello.audio_params && st.hello.audio_params.sample_rate === 24000,
    'stt non-empty': !!(st.stt && st.stt.trim()),
    'tts start+stop': st.ttsStart && st.ttsStop,
    'got downstream audio': st.opus.length > 0 && durSec > 0.2,
  };
  console.log('checks         :', JSON.stringify(checks));
  const ok = Object.values(checks).every(Boolean);
  console.log(ok ? '\nE2E: PASS ✅' : '\nE2E: FAIL ❌');
  process.exitCode = ok ? 0 : 1; // exitCode (not exit()) so stdout flushes on a pipe
}
main().catch((e) => { console.error('E2E ERROR:', e.stack || e.message); process.exitCode = 1; });
