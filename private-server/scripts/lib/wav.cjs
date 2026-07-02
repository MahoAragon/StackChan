'use strict';
/* WAV helpers shared by the e2e device emulations (e2e-turn.cjs, e2e-vision.cjs). */
const fs = require('fs');
const { execFileSync } = require('child_process');

/** Make a 16k mono WAV of `prompt` via macOS say+afconvert if one isn't supplied. */
function ensureInputWav(wavPath, prompt) {
  if (fs.existsSync(wavPath)) return;
  const aiff = wavPath.replace(/\.wav$/, '') + '.aiff';
  try {
    execFileSync('say', ['-o', aiff, prompt]);
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wavPath]);
  } catch (e) {
    throw new Error(
      `No test audio and could not generate one via macOS say/afconvert (${e.message}). ` +
        `Provide a 16 kHz mono WAV via WAV_PATH=/path/to/file.wav`,
    );
  }
}

function parseWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error('not a WAV file');
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const sz = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4) };
    else if (id === 'data') data = { offset: body, length: Math.min(sz, buf.length - body) };
    off = body + sz + (sz & 1);
    if (fmt && data) break;
  }
  if (!fmt || !data) throw new Error('missing fmt/data chunk');
  return { ...fmt, ...data };
}

function pcm16ToWav(pcm, sampleRate, channels = 1) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22); h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

module.exports = { ensureInputWav, parseWav, pcm16ToWav };
