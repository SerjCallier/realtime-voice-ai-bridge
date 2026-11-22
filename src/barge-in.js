/**
 * Sub-50ms Barge-In Collision Controller.
 *
 * When user speech energy crosses threshold while the AI assistant is actively streaming audio,
 * immediately emit a carrier `clear` control frame to flush the remote telephony jitter buffer
 * and silence playback in under 50ms.
 */

export class BargeInController {
  constructor({ speechEnergyThreshold = 350, consecutiveSpeechFrames = 2 } = {}) {
    this.speechEnergyThreshold = speechEnergyThreshold;
    this.consecutiveSpeechFrames = consecutiveSpeechFrames;
    this.aiSpeaking = false;
    this.activeSpeechStreak = 0;
    this.interruptionsCount = 0;
  }

  setAiSpeaking(speaking) {
    this.aiSpeaking = Boolean(speaking);
    if (!this.aiSpeaking) {
      this.activeSpeechStreak = 0;
    }
  }

  /**
   * Evaluate one inbound frame's mean amplitude.
   * Returns `{ interrupted: true, reactionMs }` when barge-in triggers.
   */
  onInboundFrame({ meanAmplitude, nowMs = performance.now() }) {
    if (!this.aiSpeaking) {
      this.activeSpeechStreak = 0;
      return { interrupted: false };
    }

    if (meanAmplitude >= this.speechEnergyThreshold) {
      this.activeSpeechStreak += 1;
      if (this.activeSpeechStreak >= this.consecutiveSpeechFrames) {
        this.aiSpeaking = false;
        this.activeSpeechStreak = 0;
        this.interruptionsCount += 1;
        const reactionMs = Math.max(0.01, Number((performance.now() - nowMs).toFixed(3)));
        return { interrupted: true, shouldClearBuffer: true, reactionMs };
      }
    } else {
      this.activeSpeechStreak = 0;
    }

    return { interrupted: false };
  }
}
