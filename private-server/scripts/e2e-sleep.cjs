'use strict';
/*
 * End-to-end "stop listening" test for the StackChan private-server.
 *
 * Emulates the firmware device — including its MCP server with the
 * self.robot.go_to_sleep tool (firmware/main/hal/hal_mcp.cpp) — and verifies
 * that dismissal phrases make the LLM call the tool AND stay silent (no
 * goodbye, no spoken reply), for each phrase in a fresh session:
 *   hello -> MCP initialize/tools/list (we advertise go_to_sleep + a
 *   distractor tool) -> listen start -> upstream Opus ("go away") -> listen
 *   stop -> STT -> LLM calls self.robot.go_to_sleep -> we reply like the
 *   firmware AND send the `listen stop` the real device's ReturnToIdle()
 *   emits mid-turn (the server must tolerate it) -> NO reply text/TTS ->
 *   tts stop (the server closes the bracket even for a silent turn).
 * The test asserts the turn produced no spoken audio at all.
 *
 * On the real device the tool call drives Application::ReturnToIdle()
 * (firmware/xiaozhi-esp32/main/application.cc): from Listening it drops to
 * Idle right away — and since dismissal speaks nothing, there is no Speaking
 * phase to wait out. This test covers everything up to that boundary — the
 * LLM's decision and the server's handling of the turn.
 *
 * Prerequisites — all must be running (see .env / docker-compose.yml):
 *   - private-server          (npm run start:prod)      ws://127.0.0.1:12800
 *   - llama.cpp with a TOOL-CAPABLE model               http://127.0.0.1:10000/v1
 *   - whisper                                           http://127.0.0.1:10010/inference
 *   - Kokoro (TTS)                                      http://127.0.0.1:50060/v1
 *
 * Usage:  npm run e2e:sleep
 * Env overrides: WS_URL, WHISPER_URL, E2E_PROMPTS (|-separated phrases).
 * Exit code 0 = PASS, non-zero = FAIL.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocket } = require('ws');
const OpusScript = require('opusscript');
const { ensureInputWav, parseWav, pcm16ToWav } = require('./lib/wav.cjs');

const WS_URL = process.env.WS_URL || 'ws://127.0.0.1:12800/xiaozhi/v1/';
const WHISPER_URL = process.env.WHISPER_URL || 'http://127.0.0.1:10010/inference';
const PROMPTS = (
  process.env.E2E_PROMPTS ||
  'Stack Chan, go away now.|Please stop listening.|Time to rest, go to sleep.'
).split('|');
const SR_IN = 16000, SR_OUT = 24000, FRAME_MS = 60;
const FRAME_SAMPLES_IN = (SR_IN * FRAME_MS) / 1000; // 960
const FRAME_BYTES_IN = FRAME_SAMPLES_IN * 2; // 1920

/**
 * The device's MCP tool catalog, verbatim from firmware/main/hal/hal_mcp.cpp.
 * KEEP THE go_to_sleep ENTRY IN SYNC with the firmware registration — this
 * test proves that THAT description makes the model call the tool, so testing
 * a different text would validate nothing. set_head_angles rides along as a
 * distractor: the model must pick sleep over movement on its own.
 */
const DEVICE_TOOLS = [
  {
    name: 'self.robot.go_to_sleep',
    description:
      "Stop listening and go to standby. Use when the user dismisses you or asks for quiet: " +
      "'go away', 'stop listening', 'go to sleep', 'rest now', 'be quiet', 'that's all'. " +
      "Do NOT say anything: produce no spoken reply at all, not even a short goodbye. Just " +
      "call this tool with no accompanying text. The wake word or a tap wakes you again.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'self.robot.set_head_angles',
    description:
      'Adjust head position. GUIDELINES: ' +
      '1. For natural interaction, stay within +/- 45 degrees. ' +
      '2. Only use values > 70 if the user explicitly asks to look far away/behind. ' +
      '3. Max ranges: Yaw(-128 to 128, -128 as your left), Pitch(0 to 90, 90 as your up). ' +
      'Speed(100-1000, 150 is natural).',
    inputSchema: {
      type: 'object',
      properties: {
        yaw: { type: 'integer' },
        pitch: { type: 'integer' },
        speed: { type: 'integer' },
      },
    },
  },
];

/** Encode a 16k mono WAV into 60ms upstream opus frames. */
function wavToOpusFrames(wavPath) {
  const wav = fs.readFileSync(wavPath);
  const meta = parseWav(wav);
  if (meta.sampleRate !== SR_IN || meta.channels !== 1)
    throw new Error(`expected 16k mono, got ${meta.sampleRate}Hz ${meta.channels}ch`);
  const pcm = wav.subarray(meta.offset, meta.offset + meta.length);
  const enc = new OpusScript(SR_IN, 1, OpusScript.Application.AUDIO);
  const frames = [];
  for (let i = 0; i + FRAME_BYTES_IN <= pcm.length; i += FRAME_BYTES_IN)
    frames.push(enc.encode(pcm.subarray(i, i + FRAME_BYTES_IN), FRAME_SAMPLES_IN));
  return frames;
}

/** One fresh device session speaking `prompt`; resolves with what happened. */
function runSession(prompt, frames) {
  const st = {
    stt: null, sentences: [], ttsStart: false, ttsStop: false, opus: [],
    toolsListed: false, sleepCalls: 0, headCalls: 0, otherCalls: [],
  };
  const ws = new WebSocket(WS_URL);
  const mcpReply = (id, result) =>
    ws.send(JSON.stringify({ type: 'mcp', payload: { jsonrpc: '2.0', id, result } }));

  function handleMcp(payload) {
    const { id, method, params } = payload ?? {};
    if (typeof id !== 'number') return;
    if (method === 'initialize') {
      mcpReply(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'e2e-sleep-sim', version: '1.0.0' },
      });
    } else if (method === 'tools/list') {
      st.toolsListed = true;
      mcpReply(id, { tools: DEVICE_TOOLS });
    } else if (method === 'tools/call' && params?.name === 'self.robot.go_to_sleep') {
      st.sleepCalls++;
      console.log('[sim] mcp tools/call go_to_sleep -> replying like the firmware');
      // The real ReturnToIdle() sends `listen stop` when called while
      // Listening (auto mode); replay it so the server's mid-turn guard
      // (ConversationSession.endUtterance early return) is exercised too.
      ws.send(JSON.stringify({ type: 'listen', state: 'stop' }));
      mcpReply(id, {
        content: [{ type: 'text', text: 'Going to standby now, silently.' }],
        isError: false,
      });
    } else if (method === 'tools/call' && params?.name === 'self.robot.set_head_angles') {
      st.headCalls++;
      mcpReply(id, { content: [{ type: 'text', text: 'true' }], isError: false });
    } else if (method === 'tools/call') {
      st.otherCalls.push(params?.name);
      mcpReply(id, { content: [{ type: 'text', text: 'true' }], isError: false });
    } else {
      ws.send(JSON.stringify({
        type: 'mcp',
        payload: { jsonrpc: '2.0', id, error: { message: `Method not implemented: ${method}` } },
      }));
    }
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for tts stop (120s)')), 120000);
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'hello', version: 1, transport: 'websocket', features: { mcp: true },
        audio_params: { format: 'opus', sample_rate: 16000, channels: 1, frame_duration: 60 },
      }));
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) { st.opus.push(Buffer.from(data)); return; }
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === 'hello') {
        // Give tool discovery a moment (it is fire-and-forget after hello) so
        // the LLM turn actually sees the catalog, then speak the prompt.
        setTimeout(() => {
          ws.send(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
          for (const f of frames) ws.send(f, { binary: true });
          ws.send(JSON.stringify({ type: 'listen', state: 'stop' }));
        }, 1500);
      } else if (m.type === 'mcp') handleMcp(m.payload);
      else if (m.type === 'stt') st.stt = m.text;
      else if (m.type === 'tts') {
        if (m.state === 'start') st.ttsStart = true;
        else if (m.state === 'sentence_start') st.sentences.push(m.text);
        else if (m.state === 'stop' && st.stt !== null) {
          // Only the reply's stop ends the session (an early bracket from a
          // queued server event would otherwise resolve before the turn).
          st.ttsStop = true; clearTimeout(timer); ws.close(); resolve(st);
        }
      }
    });
    ws.on('error', reject);
    ws.on('close', () => {
      if (!st.ttsStop) { clearTimeout(timer); reject(new Error('socket closed before tts stop')); }
    });
  });
}

/** Re-transcribe the goodbye audio via whisper (round-trip proof). */
async function retranscribe(opusFrames) {
  if (!opusFrames.length) return '(no audio)';
  const dec = new OpusScript(SR_OUT, 1, OpusScript.Application.AUDIO);
  const pcm = Buffer.concat(opusFrames.map((p) => dec.decode(p)));
  try {
    const fd = new FormData();
    fd.append('file', new Blob([new Uint8Array(pcm16ToWav(pcm, SR_OUT))], { type: 'audio/wav' }), 'reply.wav');
    fd.append('response_format', 'json');
    const r = await fetch(WHISPER_URL, { method: 'POST', body: fd });
    return (await r.json()).text;
  } catch (e) {
    return 'ERR ' + e.message;
  }
}

async function main() {
  let failures = 0;
  for (const prompt of PROMPTS) {
    const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const wavPath = path.join(os.tmpdir(), `stackchan-e2e-sleep-${slug}.wav`);
    ensureInputWav(wavPath, prompt);
    console.log(`\n[sim] "${prompt}"`);
    const st = await runSession(prompt, wavToOpusFrames(wavPath));
    console.log('  STT (user said):', JSON.stringify(st.stt));
    const silent = !st.ttsStart && st.sentences.length === 0 && st.opus.length === 0;
    if (silent) {
      console.log('  spoken reply   : (none — silent dismissal)');
    } else {
      // Something leaked: surface exactly what the robot said so the failure is
      // actionable (a chatty model emitting a goodbye despite the instruction).
      const heard = await retranscribe(st.opus);
      console.log('  LEAKED reply   :', JSON.stringify(st.sentences.join(' ')));
      console.log('  whisper reheard:', JSON.stringify(heard));
    }
    const checks = {
      'tools/list answered': st.toolsListed,
      'LLM called self.robot.go_to_sleep': st.sleepCalls > 0,
      'no spoken reply (silent dismissal)': silent,
      'turn completed (tts stop)': st.ttsStop,
    };
    // Informational, not gating: a stray head move is model noise, not a bug.
    if (st.headCalls || st.otherCalls.length)
      console.log(`  note: extra tool calls — head=${st.headCalls}, other=${JSON.stringify(st.otherCalls)}`);
    for (const [name, ok] of Object.entries(checks)) {
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
      if (!ok) failures++;
    }
  }
  console.log(failures === 0 ? '\nE2E SLEEP: PASS ✅' : `\nE2E SLEEP: FAIL ❌ (${failures})`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => { console.error('E2E ERROR:', e.stack || e.message); process.exitCode = 1; });
