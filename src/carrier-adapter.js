/**
 * Carrier-Agnostic Telephony Adapter & Regulatory/Outbound Failover.
 *
 * Normalizes Twilio Media Streams and Telnyx TeXML WebSocket envelopes behind a single contract,
 * automatically failing over to the secondary carrier when the primary carrier returns a blocking
 * or rate-limit status.
 */

export class CarrierFailoverAdapter {
  constructor({
    primary = "twilio",
    fallback = "telnyx",
    failoverOnStatusCodes = [400, 403, 429, 500, 502, 503],
    clients = {},
  } = {}) {
    this.primary = primary;
    this.fallback = fallback;
    this.failoverCodes = new Set(failoverOnStatusCodes);
    this.clients = clients;
  }

  /** Build a carrier-specific outbound media frame from 8kHz Mu-Law audio bytes. */
  buildMediaFrame(carrier, streamId, mulawBuffer) {
    const payload = Buffer.from(mulawBuffer).toString("base64");
    if (carrier === "telnyx") {
      return JSON.stringify({ event: "media", stream_id: streamId, media: { payload } });
    }
    return JSON.stringify({ event: "media", streamSid: streamId, media: { payload } });
  }

  /** Build a carrier-specific `clear` frame for instant barge-in playback flush. */
  buildClearFrame(carrier, streamId) {
    if (carrier === "telnyx") {
      return JSON.stringify({ event: "clear", stream_id: streamId });
    }
    return JSON.stringify({ event: "clear", streamSid: streamId });
  }

  /** Parse inbound carrier WebSocket message into normalized internal shape. */
  parseInboundMessage(rawJson) {
    const msg = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
    if (msg.event === "media" && msg.media?.payload) {
      return {
        type: "audio",
        streamId: msg.streamSid ?? msg.stream_id ?? null,
        mulawBytes: Buffer.from(msg.media.payload, "base64"),
      };
    }
    if (msg.event === "start") {
      return {
        type: "start",
        streamId: msg.streamSid ?? msg.stream_id ?? msg.start?.streamSid ?? null,
        callId: msg.start?.callSid ?? msg.start?.call_control_id ?? null,
      };
    }
    if (msg.event === "stop") {
      return { type: "stop", streamId: msg.streamSid ?? msg.stream_id ?? null };
    }
    return { type: "other", raw: msg };
  }

  /**
   * Execute outbound call control (e.g. transfer) with automatic carrier failover.
   */
  async executeWithFailover(operationName, params) {
    const primaryClient = this.clients[this.primary];
    const fallbackClient = this.clients[this.fallback];

    try {
      const result = await primaryClient(operationName, params);
      return { carrierUsed: this.primary, failoverTriggered: false, result };
    } catch (err) {
      const code = err?.statusCode ?? err?.status ?? 500;
      if (!this.failoverCodes.has(code) || typeof fallbackClient !== "function") {
        throw err;
      }
      const result = await fallbackClient(operationName, params);
      return {
        carrierUsed: this.fallback,
        failoverTriggered: true,
        primaryErrorCode: code,
        result,
      };
    }
  }
}
