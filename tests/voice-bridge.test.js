import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  MULAW_DECODE_TABLE,
  MULAW_ENCODE_LUT,
  applyNoiseGate,
  upsample8kTo16k,
  downsample24kTo8k,
  inboundToPcm16k,
  outboundToMulaw8k,
  GhostToolRouter,
  BargeInController,
  CarrierFailoverAdapter,
} from "../src/index.js";

test("64KB Mu-Law LUT and 256-entry decode table initialize with exact sizes and round-trip accuracy", () => {
  assert.equal(MULAW_DECODE_TABLE.length, 256);
  assert.equal(MULAW_ENCODE_LUT.length, 65536);
  assert.equal(MULAW_ENCODE_LUT.byteLength, 65536);

  // Zero-crossing silence maps cleanly
  const silenceByte = MULAW_ENCODE_LUT[0];
  assert.equal(MULAW_DECODE_TABLE[silenceByte], 0);

  // Non-zero sine wave survives G.711 logarithmic quantization within tolerance
  const sample = 12000;
  const encoded = MULAW_ENCODE_LUT[sample & 0xffff];
  const decoded = MULAW_DECODE_TABLE[encoded];
  assert.ok(Math.abs(decoded - sample) < 400, `Expected decoded ${decoded} close to ${sample}`);
});

test("Noise gate suppresses sub-threshold hum to digital silence while preserving speech", () => {
  const quiet = new Int16Array([20, -35, 10, -15, 30, -25]);
  const gatedQuiet = applyNoiseGate(quiet, 100);
  assert.equal(gatedQuiet.gatedToSilence, true);
  assert.ok(gatedQuiet.gated.every((v) => v === 0));

  const speech = new Int16Array([900, -1200, 1500, -800]);
  const gatedSpeech = applyNoiseGate(speech, 100);
  assert.equal(gatedSpeech.gatedToSilence, false);
  assert.deepEqual(Array.from(gatedSpeech.gated), Array.from(speech));
});

test("Inbound 8kHz->16kHz and outbound 24kHz->8kHz DSP pipelines preserve frame ratios", () => {
  const upsampled = upsample8kTo16k(new Int16Array([100, 300, 500]));
  assert.deepEqual(Array.from(upsampled), [100, 200, 300, 400, 500, 500]);

  const decimated = downsample24kTo8k(new Int16Array([10, 11, 12, 20, 21, 22, 30, 31, 32]));
  assert.deepEqual(Array.from(decimated), [10, 20, 30]);

  // 20ms carrier frame (160 bytes @ 8kHz) -> 320 samples @ 16kHz (640 bytes PCM16)
  const mulawIn = Buffer.alloc(160, 0x1e);
  const inbound = inboundToPcm16k(mulawIn, { noiseGateAmplitude: 50 });
  assert.equal(inbound.pcm16kSamples.length, 320);
  assert.equal(inbound.pcm16kBuffer.byteLength, 640);

  // 20ms model frame (480 samples @ 24kHz) -> 160 bytes @ 8kHz Mu-Law
  const pcm24k = new Int16Array(480).fill(5000);
  const outbound = outboundToMulaw8k(pcm24k, { gain: 1.0 });
  assert.equal(outbound.length, 160);
});

test("GhostToolRouter parses tags split across chunks, strips tags, and dispatches idempotently", async () => {
  const dispatched = [];
  const router = new GhostToolRouter({
    dispatcher: async (payload) => {
      dispatched.push(payload);
      return { ok: true };
    },
  });

  const c1 = router.ingestDelta("Connecting you now [TRANS", { callId: "c-101" });
  assert.equal(c1.cleanText, "Connecting you now ");
  assert.equal(c1.triggered.length, 0);

  const c2 = router.ingestDelta("FER_NOW] please hold. [TRANSFER_NOW]", { callId: "c-101" });
  await Promise.all(c2.triggered.map((t) => t.promise));

  const finalOut = (c1.cleanText + c2.cleanText + router.flush()).replace(/\s+/g, " ").trim();
  assert.equal(finalOut, "Connecting you now please hold.");
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].event, "call.transfer.primary_queue");
  assert.equal(dispatched[0].callId, "c-101");
});

test("BargeInController triggers clear signal only during active AI speech after consecutive frames", () => {
  const controller = new BargeInController({ speechEnergyThreshold: 350, consecutiveSpeechFrames: 2 });

  // While AI is silent, high energy does not emit barge-in
  assert.equal(controller.onInboundFrame({ meanAmplitude: 2000 }).interrupted, false);

  controller.setAiSpeaking(true);
  // Single transient spike does not false-trigger
  assert.equal(controller.onInboundFrame({ meanAmplitude: 600 }).interrupted, false);
  // Second consecutive speech frame triggers immediate clear
  const hit = controller.onInboundFrame({ meanAmplitude: 750 });
  assert.equal(hit.interrupted, true);
  assert.equal(hit.shouldClearBuffer, true);
  assert.ok(hit.reactionMs < 50, `Expected <50ms reaction, got ${hit.reactionMs}ms`);
  assert.equal(controller.interruptionsCount, 1);
});

test("CarrierFailoverAdapter normalizes Twilio/Telnyx frames and fails over on 403 block", async () => {
  const adapter = new CarrierFailoverAdapter({
    primary: "twilio",
    fallback: "telnyx",
    clients: {
      twilio: async () => {
        const err = new Error("Regulatory block");
        err.statusCode = 403;
        throw err;
      },
      telnyx: async (op, params) => ({ ok: true, op, to: params.to }),
    },
  });

  assert.deepEqual(JSON.parse(adapter.buildClearFrame("twilio", "S1")), { event: "clear", streamSid: "S1" });
  assert.deepEqual(JSON.parse(adapter.buildClearFrame("telnyx", "S2")), { event: "clear", stream_id: "S2" });

  const parsed = adapter.parseInboundMessage(
    JSON.stringify({ event: "media", streamSid: "S1", media: { payload: Buffer.from([1, 2, 3]).toString("base64") } }),
  );
  assert.equal(parsed.type, "audio");
  assert.equal(parsed.streamId, "S1");
  assert.deepEqual(Array.from(parsed.mulawBytes), [1, 2, 3]);

  const res = await adapter.executeWithFailover("transfer", { to: "desk-1" });
  assert.equal(res.carrierUsed, "telnyx");
  assert.equal(res.failoverTriggered, true);
  assert.equal(res.primaryErrorCode, 403);
  assert.equal(res.result.ok, true);
});

test("Minimal config example parses cleanly and exposes expected non-secret sections", () => {
  const cfgPath = path.resolve(process.cwd(), "config.example.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  assert.equal(cfg.dsp.carrierSampleRateHz, 8000);
  assert.equal(cfg.dsp.modelInputSampleRateHz, 16000);
  assert.equal(cfg.dsp.modelOutputSampleRateHz, 24000);
  assert.equal(cfg.bargeIn.maxReactionBudgetMs, 50);
  assert.equal(cfg.carriers.primary, "twilio");
  assert.equal(cfg.carriers.fallback, "telnyx");
});
