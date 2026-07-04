'use strict';
/*
 * End-to-end test for the server-push device events API.
 *
 * Emulates a firmware device over the xiaozhi WS protocol (hello handshake,
 * Device-Id header), then drives the HTTP events API and asserts the frames
 * the "device" receives:
 *   - auth is enforced (401 without/with wrong bearer)
 *   - GET devices / GET sounds see the connected device and the library
 *   - POST emotion  -> llm frame with the emotion
 *   - POST sound    -> tts start/<opus frames>/stop bracket, correct length
 *   - multipart WAV upload (44.1k stereo) -> decoded + resampled + played
 *   - busy queueing -> second sound is 'queued', then plays after the first
 *   - user preemption -> `listen start` mid-sound cuts the event short
 *   - keepalive     -> {"type":"ping"} frames arrive on an idle socket
 *   - POST say      -> sentence_start + audio (SKIPPED if no TTS backend)
 *
 * Prerequisites: private-server running with XIAOZHI_EVENTS_TOKEN set (and a
 * short XIAOZHI_KEEPALIVE_MS to exercise the keepalive quickly), e.g.:
 *   PORT=12900 XIAOZHI_EVENTS_TOKEN=test-token XIAOZHI_KEEPALIVE_MS=1500 \
 *     npm run start:prod
 *
 * Usage:  npm run e2e:events
 * Env: BASE_URL (default http://127.0.0.1:12900), EVENTS_TOKEN (test-token).
 * Exit code 0 = PASS, non-zero = FAIL.
 */
const { WebSocket } = require('ws');
const OpusScript = require('opusscript');

const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:12900').replace(/\/$/, '');
const WS_URL = BASE_URL.replace(/^http/, 'ws') + '/xiaozhi/v1/';
const TOKEN = process.env.EVENTS_TOKEN || 'test-token';
const DEVICE_ID = 'e2e-events-device';
const SR_OUT = 24000, FRAME_MS = 60;

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Records every frame the fake device receives, for assertions. */
class FakeDevice {
  constructor() {
    this.frames = []; // {t, type, msg} for text, {t, type:'opus', bytes} for binary
    this.ws = null;
  }
  async connect() {
    this.ws = new WebSocket(WS_URL, {
      headers: { 'device-id': DEVICE_ID, 'client-id': 'e2e-client', authorization: 'Bearer stackchan' },
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no server hello in 5s')), 5000);
      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({
          type: 'hello', version: 1, transport: 'websocket',
          audio_params: { format: 'opus', sample_rate: 16000, channels: 1, frame_duration: 60 },
        }));
      });
      this.ws.on('message', (data, isBinary) => {
        const t = Date.now();
        if (isBinary) { this.frames.push({ t, type: 'opus', bytes: Buffer.from(data) }); return; }
        let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
        this.frames.push({ t, type: msg.type === 'tts' ? `tts:${msg.state}` : msg.type, msg });
        if (msg.type === 'hello') { clearTimeout(timer); resolve(); }
      });
      this.ws.on('error', reject);
    });
  }
  /** Frames received after `since` (an index from mark()). */
  mark() { return this.frames.length; }
  since(mark) { return this.frames.slice(mark); }
  async waitFor(mark, predicate, timeoutMs, what) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = this.since(mark).find(predicate);
      if (hit) return hit;
      await sleep(25);
    }
    throw new Error(`timeout waiting for ${what}`);
  }
  close() { try { this.ws?.close(); } catch { /* ignore */ } }
}

async function api(method, pathname, { body, token = TOKEN, form } = {}) {
  const headers = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${BASE_URL}${pathname}`, { method, headers, body: payload });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON error body */ }
  return { status: res.status, json };
}

/** Generate a sine-tone WAV buffer for upload tests. */
function makeWav({ seconds, sampleRate, channels, freq = 660 }) {
  const frames = Math.round(seconds * sampleRate);
  const pcm = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * 12000);
    for (let c = 0; c < channels; c++) pcm.writeInt16LE(v, (i * channels + c) * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Decode received opus frames and report RMS, to prove the audio is real. */
function opusRms(frames) {
  const dec = new OpusScript(SR_OUT, 1, OpusScript.Application.AUDIO);
  let sum = 0, n = 0;
  for (const f of frames) {
    try {
      const pcm = dec.decode(f.bytes);
      for (let i = 0; i + 1 < pcm.length; i += 2) { const s = pcm.readInt16LE(i); sum += s * s; n++; }
    } catch { /* count as silence */ }
  }
  return n ? Math.sqrt(sum / n) : 0;
}

/** Wait for one full tts start..stop bracket after `mark`; return its frames. */
async function waitBracket(dev, mark, timeoutMs = 15000) {
  await dev.waitFor(mark, (f) => f.type === 'tts:start', timeoutMs, 'tts start');
  const stop = await dev.waitFor(mark, (f) => f.type === 'tts:stop', timeoutMs, 'tts stop');
  const frames = dev.since(mark);
  return frames.slice(0, frames.indexOf(stop) + 1);
}

async function main() {
  console.log(`[e2e-events] server ${BASE_URL}, device ${DEVICE_ID}`);

  // --- auth ---------------------------------------------------------------
  let r = await api('POST', '/xiaozhi/events/say', { body: { text: 'x' }, token: null });
  check('auth: missing bearer rejected', r.status === 401 || r.status === 503, `status=${r.status}`);
  r = await api('POST', '/xiaozhi/events/say', { body: { text: 'x' }, token: 'wrong-token' });
  check('auth: wrong bearer rejected', r.status === 401, `status=${r.status}`);

  // --- no device yet ------------------------------------------------------
  r = await api('POST', '/xiaozhi/events/say', { body: { text: 'x' } });
  check('say with no device -> 404', r.status === 404, `status=${r.status}`);

  // A socket that never completes the hello handshake (port scan, health
  // check) must not become a push target.
  const bogus = new WebSocket(WS_URL, { headers: { 'device-id': 'bogus-no-hello' } });
  await new Promise((resolve) => bogus.on('open', resolve));
  await sleep(300);
  r = await api('POST', '/xiaozhi/events/say', { body: { text: 'x' } });
  check('pre-hello socket is not a push target', r.status === 404, `status=${r.status}`);
  bogus.close();

  // --- connect the fake device --------------------------------------------
  const dev = new FakeDevice();
  await dev.connect();
  check('device hello handshake', true);

  r = await api('GET', '/xiaozhi/events/devices');
  const listed = r.json?.devices?.find((d) => d.deviceId === DEVICE_ID);
  check('devices lists the connection', !!listed, JSON.stringify(r.json));

  // --- keepalive ------------------------------------------------------------
  const kaMark = dev.mark();
  try {
    await dev.waitFor(kaMark, (f) => f.type === 'ping', 4000, 'keepalive ping');
    check('keepalive ping received', true);
  } catch {
    check('keepalive ping received', false, 'no {"type":"ping"} in 4s (is XIAOZHI_KEEPALIVE_MS=1500 set?)');
  }

  // --- emotion --------------------------------------------------------------
  let m = dev.mark();
  r = await api('POST', '/xiaozhi/events/emotion', { body: { emotion: 'happy' } });
  check('emotion accepted', r.status === 200 && r.json?.status === 'sent', JSON.stringify(r.json));
  const llmFrame = await dev.waitFor(m, (f) => f.type === 'llm', 2000, 'llm frame');
  check('emotion llm frame', llmFrame.msg.emotion === 'happy', JSON.stringify(llmFrame.msg));
  r = await api('POST', '/xiaozhi/events/emotion', { body: { emotion: 'bogus' } });
  check('unknown emotion -> 400', r.status === 400, `status=${r.status}`);

  // --- library sound ---------------------------------------------------------
  r = await api('GET', '/xiaozhi/events/sounds');
  check('sound library lists chime', r.json?.sounds?.includes('chime'), JSON.stringify(r.json));
  m = dev.mark();
  r = await api('POST', '/xiaozhi/events/sound', { body: { name: 'chime' } });
  check('sound accepted', r.status === 200 && r.json?.status === 'playing', JSON.stringify(r.json));
  let bracket = await waitBracket(dev, m);
  let opus = bracket.filter((f) => f.type === 'opus');
  // chime.wav is 0.75s -> 12.5 frames -> 13 with the flush frame
  check('sound frame count ~13', opus.length >= 12 && opus.length <= 14, `${opus.length} frames`);
  check('sound has no sentence text', !bracket.some((f) => f.type === 'tts:sentence_start'));
  check('sound emits no emotion frame', !bracket.some((f) => f.type === 'llm'));
  check('sound audio is not silence', opusRms(opus) > 500, `rms=${Math.round(opusRms(opus))}`);
  const bracketMs = bracket[bracket.length - 1].t - bracket[0].t;
  check('sound paced to real time', bracketMs >= 500, `bracket lasted ${bracketMs}ms for 750ms audio`);

  // --- multipart upload (44.1k stereo -> resample + downmix) -----------------
  const form = new FormData();
  form.append('file', new Blob([makeWav({ seconds: 1.2, sampleRate: 44100, channels: 2 })]), 'tone.wav');
  m = dev.mark();
  r = await api('POST', '/xiaozhi/events/sound', { form });
  check('upload accepted', r.status === 200 && r.json?.status === 'playing', JSON.stringify(r.json));
  check('upload duration decoded', Math.abs((r.json?.durationSecs ?? 0) - 1.2) < 0.05, `durationSecs=${r.json?.durationSecs}`);
  bracket = await waitBracket(dev, m);
  opus = bracket.filter((f) => f.type === 'opus');
  check('upload frame count ~21', opus.length >= 19 && opus.length <= 22, `${opus.length} frames`);
  check('upload audio is not silence', opusRms(opus) > 500, `rms=${Math.round(opusRms(opus))}`);

  // --- busy queueing ----------------------------------------------------------
  m = dev.mark();
  const [r1, r2] = await Promise.all([
    api('POST', '/xiaozhi/events/sound', { body: { name: 'chime' } }),
    api('POST', '/xiaozhi/events/sound', { body: { name: 'chime' } }),
  ]);
  const statuses = [r1.json?.status, r2.json?.status].sort();
  check('concurrent posts: one plays, one queues', statuses[0] === 'playing' && statuses[1] === 'queued', JSON.stringify(statuses));
  // The queued chime chains with no gap after the first, so count complete
  // brackets from the original mark instead of re-marking between them.
  const bracketsDeadline = Date.now() + 15000;
  while (dev.since(m).filter((f) => f.type === 'tts:stop').length < 2) {
    if (Date.now() > bracketsDeadline) throw new Error('timeout waiting for the queued chime');
    await sleep(50);
  }
  const starts = dev.since(m).filter((f) => f.type === 'tts:start').length;
  check('queued sound played after the first', starts === 2, `${starts} tts brackets`);

  // --- user preemption ---------------------------------------------------------
  m = dev.mark();
  const form2 = new FormData();
  form2.append('file', new Blob([makeWav({ seconds: 6, sampleRate: 24000, channels: 1 })]), 'long.wav');
  r = await api('POST', '/xiaozhi/events/sound', { form: form2 });
  check('long sound accepted', r.json?.status === 'playing', JSON.stringify(r.json));
  await dev.waitFor(m, (f) => f.type === 'tts:start', 5000, 'long sound start');
  await sleep(400); // let a few frames flow
  dev.ws.send(JSON.stringify({ type: 'listen', state: 'start', mode: 'manual' })); // user barge-in
  const stopAt = Date.now();
  await dev.waitFor(m, (f) => f.type === 'tts:stop', 3000, 'preemption tts stop');
  check('user listen start preempts sound', Date.now() - stopAt < 1500, `stop after ${Date.now() - stopAt}ms`);
  const framesAfterStop = dev.mark();
  await sleep(800);
  const lateOpus = dev.since(framesAfterStop).filter((f) => f.type === 'opus');
  check('no audio after preemption', lateOpus.length === 0, `${lateOpus.length} late frames`);
  dev.ws.send(JSON.stringify({ type: 'listen', state: 'stop' })); // end the empty utterance

  // --- say (needs the TTS backend) ---------------------------------------------
  // The preemption test's listen start/stop just counted as user activity, so
  // this event must respect the quiet grace (default 2s) before playing.
  m = dev.mark();
  const sayPostedAt = Date.now();
  r = await api('POST', '/xiaozhi/events/say', { body: { text: 'Notification test.', emotion: 'happy' } });
  check('say accepted', r.status === 200 && ['playing', 'queued'].includes(r.json?.status), JSON.stringify(r.json));
  try {
    bracket = await waitBracket(dev, m, 20000);
    const sayStart = bracket.find((f) => f.type === 'tts:start');
    const graceMs = sayStart.t - sayPostedAt;
    check('say waited for the quiet grace', graceMs >= 1000, `started ${graceMs}ms after post (user activity ~0s before)`);
    const sentence = bracket.find((f) => f.type === 'tts:sentence_start');
    const sayLlm = bracket.find((f) => f.type === 'llm');
    opus = bracket.filter((f) => f.type === 'opus');
    check('say spoke the text', sentence?.msg.text === 'Notification test.', JSON.stringify(sentence?.msg));
    check('say carried the emotion', sayLlm?.msg.emotion === 'happy', JSON.stringify(sayLlm?.msg));
    check('say produced audio', opus.length > 5 && opusRms(opus) > 200, `${opus.length} frames, rms=${Math.round(opusRms(opus))}`);
  } catch (err) {
    console.log(`SKIP  say playback — ${err.message} (TTS backend not running?)`);
  }

  dev.close();
  await sleep(200);
  console.log(failures === 0 ? '\n[e2e-events] PASS' : `\n[e2e-events] FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`[e2e-events] ERROR: ${err.stack ?? err}`);
  process.exit(1);
});
