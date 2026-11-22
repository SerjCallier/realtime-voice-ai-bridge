/**
 * Ghost Tools Pattern — Non-blocking async side-effect dispatcher.
 *
 * Problem: Synchronous LLM `function_call` turns pause real-time audio pipelines (~20s round-trip).
 * Solution: The model emits lightweight inline control tags (e.g. `[TRANSFER_NOW]`) inside its
 * text/transcript stream. The bridge intercepts tags across chunk boundaries, strips them from
 * user-facing text, and dispatches async webhooks without blocking the audio WebSocket loop.
 */

const DEFAULT_ROUTES = {
  "[TRANSFER_NOW]": "call.transfer.primary_queue",
  "[ESCALATE_HITL]": "alert.hitl.urgent",
  "[BOOK_CALLBACK]": "crm.lead.callback",
  "[END_CALL]": "call.terminate",
};

export class GhostToolRouter {
  constructor({
    routes = DEFAULT_ROUTES,
    stripTagsFromTranscript = true,
    dispatcher = null,
    timeoutMs = 2500,
  } = {}) {
    this.routes = { ...routes };
    this.tags = Object.keys(this.routes);
    this.stripTagsFromTranscript = stripTagsFromTranscript;
    this.timeoutMs = timeoutMs;
    this.dispatcher = dispatcher;
    this.pendingTail = "";
    this.firedPerTurn = new Set();
    this.maxTagLength = this.tags.reduce((m, t) => Math.max(m, t.length), 0);
  }

  /** Reset per-turn idempotency state when a new conversational turn begins. */
  resetTurn() {
    this.pendingTail = "";
    this.firedPerTurn.clear();
  }

  /**
   * Process an incoming streaming text delta without blocking caller audio.
   * Returns sanitized text + any newly triggered async dispatch promises.
   */
  ingestDelta(delta, context = {}) {
    if (!delta) return { cleanText: "", triggered: [] };

    const combined = this.pendingTail + delta;
    const triggered = [];

    for (const tag of this.tags) {
      if (combined.includes(tag) && !this.firedPerTurn.has(tag)) {
        this.firedPerTurn.add(tag);
        const eventName = this.routes[tag];
        const dispatchPromise = this.#dispatchAsync(eventName, tag, context);
        triggered.push({ tag, eventName, promise: dispatchPromise });
      }
    }

    // Hold trailing partial bracket token (e.g. "[TRANS") so split tags across chunks are never missed
    let emitBoundary = combined.length;
    const openIdx = combined.lastIndexOf("[");
    if (openIdx !== -1 && combined.indexOf("]", openIdx) === -1) {
      const candidateTail = combined.slice(openIdx);
      if (candidateTail.length < this.maxTagLength && this.tags.some((t) => t.startsWith(candidateTail))) {
        emitBoundary = openIdx;
      }
    }

    let emittable = combined.slice(0, emitBoundary);
    this.pendingTail = combined.slice(emitBoundary);

    if (this.stripTagsFromTranscript) {
      for (const tag of this.tags) {
        emittable = emittable.split(tag).join("");
      }
      emittable = emittable.replace(/\s{2,}/g, " ");
    }

    return { cleanText: emittable, triggered };
  }

  /** Flush any buffered partial tail at end of model turn. */
  flush() {
    let tail = this.pendingTail;
    this.pendingTail = "";
    if (this.stripTagsFromTranscript) {
      for (const tag of this.tags) {
        tail = tail.split(tag).join("");
      }
    }
    return tail.trim();
  }

  async #dispatchAsync(eventName, tag, context) {
    const payload = {
      event: eventName,
      tag,
      callId: context.callId ?? "unknown",
      timestamp: new Date().toISOString(),
      metadata: context.metadata ?? {},
    };

    if (typeof this.dispatcher === "function") {
      return this.dispatcher(payload);
    }

    if (context.webhookUrl) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(context.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        return { ok: res.ok, status: res.status, event: eventName };
      } finally {
        clearTimeout(timer);
      }
    }

    return { ok: true, dryRun: true, payload };
  }
}
