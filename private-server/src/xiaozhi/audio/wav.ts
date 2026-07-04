/**
 * Minimal WAV encode/decode used by the voice pipeline: wrap PCM for the STT
 * endpoint, and decode arbitrary notification-sound WAVs into the device's
 * downstream format. No external imports.
 */

/** WAVE format tags we can decode. */
const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
/** Wrapper whose real format tag lives in the fmt extension (SubFormat GUID). */
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

/**
 * Decode a WAV file to PCM16 LE mono at `targetRate`, ready for the
 * downstream opus encoder. Accepts integer PCM (8/16/24/32-bit) and 32-bit
 * float, any channel count (averaged to mono) and any sample rate (linear
 * interpolation — fine for notification sounds; use a proper resampler if
 * music fidelity ever matters). Throws with a specific message on anything
 * it cannot decode so the HTTP caller learns why their file was rejected.
 */
export function wavToPcm16Mono(wav: Buffer, targetRate: number): Buffer {
  if (
    wav.length < 12 ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('not a RIFF/WAVE file');
  }

  let fmt: Buffer | undefined;
  let data: Buffer | undefined;
  // Walk the chunk list rather than assuming the canonical 44-byte layout:
  // real-world WAVs carry LIST/fact/cue chunks before fmt/data.
  let off = 12;
  while (off + 8 <= wav.length) {
    const id = wav.toString('ascii', off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    const body = wav.subarray(off + 8, Math.min(off + 8 + size, wav.length));
    if (id === 'fmt ') fmt = body;
    else if (id === 'data') data = body;
    off += 8 + size + (size & 1); // chunks are word-aligned
  }
  if (!fmt || fmt.length < 16) throw new Error('missing fmt chunk');
  if (!data || data.length === 0) throw new Error('missing data chunk');

  let formatTag = fmt.readUInt16LE(0);
  const channels = fmt.readUInt16LE(2);
  const sampleRate = fmt.readUInt32LE(4);
  const bitsPerSample = fmt.readUInt16LE(14);
  if (formatTag === WAVE_FORMAT_EXTENSIBLE && fmt.length >= 26) {
    formatTag = fmt.readUInt16LE(24); // first 2 bytes of the SubFormat GUID
  }
  if (channels < 1 || sampleRate < 8000 || sampleRate > 192000) {
    throw new Error(`unsupported WAV layout (${channels}ch @ ${sampleRate}Hz)`);
  }

  const mono = decodeToMonoFloat(data, formatTag, bitsPerSample, channels);
  const out =
    sampleRate === targetRate ? mono : resampleLinear(mono, sampleRate, targetRate);

  const pcm = Buffer.alloc(out.length * 2);
  for (let i = 0; i < out.length; i++) {
    const clamped = Math.max(-1, Math.min(1, out[i]));
    pcm.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  return pcm;
}

/** Decode interleaved samples to normalized mono floats (channel average). */
function decodeToMonoFloat(
  data: Buffer,
  formatTag: number,
  bitsPerSample: number,
  channels: number,
): Float64Array {
  const readSample = sampleReader(formatTag, bitsPerSample);
  const bytesPerSample = bitsPerSample / 8;
  const frameBytes = bytesPerSample * channels;
  const frames = Math.floor(data.length / frameBytes);
  const mono = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      sum += readSample(data, f * frameBytes + c * bytesPerSample);
    }
    mono[f] = sum / channels;
  }
  return mono;
}

/** Returns a reader mapping one sample at `offset` to a float in [-1, 1]. */
function sampleReader(
  formatTag: number,
  bits: number,
): (data: Buffer, offset: number) => number {
  if (formatTag === WAVE_FORMAT_IEEE_FLOAT && bits === 32) {
    return (d, o) => d.readFloatLE(o);
  }
  if (formatTag === WAVE_FORMAT_PCM) {
    switch (bits) {
      case 8: // 8-bit WAV is unsigned
        return (d, o) => (d.readUInt8(o) - 128) / 128;
      case 16:
        return (d, o) => d.readInt16LE(o) / 32768;
      case 24:
        return (d, o) => {
          const v = d.readUIntLE(o, 3);
          return (v >= 0x800000 ? v - 0x1000000 : v) / 8388608;
        };
      case 32:
        return (d, o) => d.readInt32LE(o) / 2147483648;
    }
  }
  throw new Error(`unsupported WAV encoding (format=${formatTag}, ${bits}-bit)`);
}

/** Linear-interpolation resampler (mono float). */
function resampleLinear(
  input: Float64Array,
  fromRate: number,
  toRate: number,
): Float64Array {
  const outLength = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const out = new Float64Array(outLength);
  const step = fromRate / toRate;
  for (let i = 0; i < outLength; i++) {
    const pos = i * step;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

/**
 * Wrap raw 16-bit little-endian PCM samples in a minimal canonical WAV container.
 * Used to hand decoded upstream audio to the OpenAI-compatible STT endpoint, which
 * wants a real audio file rather than headerless PCM.
 */
export function pcm16ToWav(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample; // bytes per sample frame (all channels)
  const byteRate = sampleRate * blockAlign; // bytes per second
  const dataSize = pcm.length;

  // 44-byte canonical PCM header (RIFF + fmt + data chunks) followed by the samples.
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4); // RIFF chunk size = header remainder + data
  header.write('WAVE', 8, 'ascii');

  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size (PCM)
  header.writeUInt16LE(1, 20); // audio format 1 = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);

  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}
