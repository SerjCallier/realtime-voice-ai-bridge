import { inboundToPcm16k, outboundToMulaw8k } from "./dsp.js";
import { GhostToolRouter } from "./ghost-tools.js";
import { BargeInController } from "./barge-in.js";
import { CarrierFailoverAdapter } from "./carrier-adapter.js";

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main() {
  const frames = 1000;
  const mulawFrame = Buffer.alloc(160); // 20ms @ 8kHz
  for (let i = 0; i < mulawFrame.length; i++) {
    mulawFrame[i] = (i * 7 + 31) & 0xff;
  }

  const pcm24kFrame = new Int16Array(480); // 20ms @ 24kHz
  for (let i = 0; i < pcm24kFrame.length; i++) {
    pcm24kFrame[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 24000) * 12000);
  }

  const dspTimingsMs = [];
  for (let i = 0; i < frames; i++) {
    const t0 = performance.now();
    inboundToPcm16k(mulawFrame, { noiseGateAmplitude: 100 });
    outboundToMulaw8k(pcm24kFrame, { gain: 1.0 });
    dspTimingsMs.push(performance.now() - t0);
  }
  dspTimingsMs.sort((a, b) => a - b);

  const dispatches = [];
  const router = new GhostToolRouter({
    dispatcher: async (payload) => {
      dispatches.push(payload);
      return { ok: true, event: payload.event };
    },
  });

  const chunk1 = router.ingestDelta("Sure, transferring you now [TRANS", { callId: "demo-call-01" });
  const chunk2 = router.ingestDelta("FER_NOW] one moment please.", { callId: "demo-call-01" });
  await Promise.all([...chunk1.triggered, ...chunk2.triggered].map((t) => t.promise));

  const bargeIn = new BargeInController({ speechEnergyThreshold: 350, consecutiveSpeechFrames: 2 });
  bargeIn.setAiSpeaking(true);
  bargeIn.onInboundFrame({ meanAmplitude: 1200 });
  const collision = bargeIn.onInboundFrame({ meanAmplitude: 1450 });

  const adapter = new CarrierFailoverAdapter({
    primary: "twilio",
    fallback: "telnyx",
    clients: {
      twilio: async () => {
        const err = new Error("Outbound carrier block");
        err.statusCode = 403;
        throw err;
      },
      telnyx: async (op, params) => ({ transferred: true, op, target: params.target }),
    },
  });
  const failoverResult = await adapter.executeWithFailover("transfer", { target: "queue-primary" });
  const clearFrame = adapter.buildClearFrame("twilio", "MZ_DEMO_STREAM");

  const summary = {
    dsp_frames_benchmarked: frames,
    dsp_roundtrip_p50_ms: Number(percentile(dspTimingsMs, 50).toFixed(4)),
    dsp_roundtrip_p95_ms: Number(percentile(dspTimingsMs, 95).toFixed(4)),
    ghost_tools_clean_text: (chunk1.cleanText + chunk2.cleanText + router.flush()).trim(),
    ghost_tools_dispatched: dispatches.map((d) => d.event),
    barge_in_interrupted: collision.interrupted,
    barge_in_clear_frame: JSON.parse(clearFrame),
    carrier_failover: failoverResult,
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
