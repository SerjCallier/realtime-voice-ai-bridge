/**
 * O(1) G.711 Mu-Law <-> Linear PCM16 DSP Pipeline.
 *
 * Inbound path:  8kHz Mu-Law -> Noise Gate -> 16kHz PCM16 (linear interpolation)
 * Outbound path: 24kHz PCM16 -> 3:1 Decimation -> 8kHz Mu-Law via precomputed 64KB LUT
 */

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

function decodeMulawByte(mulawByte) {
  const u = (~mulawByte) & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const magnitude = ((mantissa << 3) + MULAW_BIAS) << exponent;
  return sign ? MULAW_BIAS - magnitude : magnitude - MULAW_BIAS;
}

function encodeMulawSample(sample) {
  let pcm = Math.max(-32768, Math.min(32767, sample | 0));
  let sign = 0;
  if (pcm < 0) {
    sign = 0x80;
    pcm = -pcm;
  }
  if (pcm > MULAW_CLIP) pcm = MULAW_CLIP;
  pcm += MULAW_BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (pcm & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {
    // Find highest set bit for segment exponent
  }

  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

/** 256-entry Mu-Law to PCM16 decode table (512 bytes). */
export const MULAW_DECODE_TABLE = (() => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    table[i] = decodeMulawByte(i);
  }
  return table;
})();

/** Precomputed 64KB PCM16 to Mu-Law encode LUT for O(1) outbound conversion. */
export const MULAW_ENCODE_LUT = (() => {
  const lut = new Uint8Array(65536);
  for (let u16 = 0; u16 < 65536; u16++) {
    const signed = u16 >= 0x8000 ? u16 - 0x10000 : u16;
    lut[u16] = encodeMulawSample(signed);
  }
  return lut;
})();

/**
 * Compute mean absolute amplitude of a PCM16 sample array.
 * Used by both Noise Gate and Barge-In collision detector.
 */
export function computeMeanAmplitude(pcmSamples) {
  if (!pcmSamples || pcmSamples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcmSamples.length; i++) {
    const v = pcmSamples[i];
    sum += v < 0 ? -v : v;
  }
  return sum / pcmSamples.length;
}

/**
 * Clamp low-energy line hum to pure digital silence (0) to keep model VAD clean.
 */
export function applyNoiseGate(pcmSamples, threshold = 100) {
  const meanAmp = computeMeanAmplitude(pcmSamples);
  if (meanAmp < threshold) {
    return { gated: new Int16Array(pcmSamples.length), gatedToSilence: true, meanAmplitude: meanAmp };
  }
  return { gated: pcmSamples, gatedToSilence: false, meanAmplitude: meanAmp };
}

/**
 * Linear interpolation upsampler: 8kHz PCM16 -> 16kHz PCM16.
 */
export function upsample8kTo16k(pcm8k) {
  if (!pcm8k || pcm8k.length === 0) return new Int16Array(0);
  const out = new Int16Array(pcm8k.length * 2);
  for (let i = 0; i < pcm8k.length; i++) {
    const curr = pcm8k[i];
    const next = i + 1 < pcm8k.length ? pcm8k[i + 1] : curr;
    out[i * 2] = curr;
    out[i * 2 + 1] = (curr + next) >> 1;
  }
  return out;
}

/**
 * Fast 3:1 decimation downsampler: 24kHz PCM16 -> 8kHz PCM16.
 */
export function downsample24kTo8k(pcm24k) {
  if (!pcm24k || pcm24k.length === 0) return new Int16Array(0);
  const outLen = Math.floor(pcm24k.length / 3);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    out[i] = pcm24k[i * 3];
  }
  return out;
}

/**
 * Inbound carrier frame (8kHz Mu-Law Buffer/Uint8Array) -> 16kHz PCM16 Buffer + VAD telemetry.
 */
export function inboundToPcm16k(mulawBytes, { noiseGateAmplitude = 100 } = {}) {
  const pcm8k = new Int16Array(mulawBytes.length);
  for (let i = 0; i < mulawBytes.length; i++) {
    pcm8k[i] = MULAW_DECODE_TABLE[mulawBytes[i] & 0xff];
  }
  const { gated, gatedToSilence, meanAmplitude } = applyNoiseGate(pcm8k, noiseGateAmplitude);
  const pcm16k = upsample8kTo16k(gated);
  return {
    pcm16kBuffer: Buffer.from(pcm16k.buffer, pcm16k.byteOffset, pcm16k.byteLength),
    pcm16kSamples: pcm16k,
    meanAmplitude,
    gatedToSilence,
  };
}

/**
 * Outbound model frame (24kHz PCM16 Buffer/Int16Array) -> 8kHz Mu-Law Buffer via O(1) 64KB LUT.
 */
export function outboundToMulaw8k(pcm24kInput, { gain = 1.0 } = {}) {
  const pcm24k =
    pcm24kInput instanceof Int16Array
      ? pcm24kInput
      : new Int16Array(pcm24kInput.buffer, pcm24kInput.byteOffset, Math.floor(pcm24kInput.byteLength / 2));

  const pcm8k = downsample24kTo8k(pcm24k);
  const mulaw = Buffer.allocUnsafe(pcm8k.length);

  for (let i = 0; i < pcm8k.length; i++) {
    const scaled = gain === 1.0 ? pcm8k[i] : Math.max(-32768, Math.min(32767, Math.round(pcm8k[i] * gain)));
    mulaw[i] = MULAW_ENCODE_LUT[scaled & 0xffff];
  }

  return mulaw;
}
