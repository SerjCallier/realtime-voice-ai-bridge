import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  inboundToPcm16k,
  BargeInController,
  CarrierFailoverAdapter,
  GhostToolRouter,
} from "./index.js";

const WS_MAGIC_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function encodeWsTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  if (payload.length < 126) {
    const header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text frame
    header[1] = payload.length;
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function tryDecodeWsFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let payloadLen = buf[1] & 0x7f;
  let offset = 2;

  if (payloadLen === 126) {
    if (buf.length < 4) return null;
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buf.length < 10) return null;
    payloadLen = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }

  const maskOffset = offset;
  if (masked) offset += 4;
  if (buf.length < offset + payloadLen) return null;

  const payload = Buffer.from(buf.subarray(offset, offset + payloadLen));
  if (masked) {
    const mask = buf.subarray(maskOffset, maskOffset + 4);
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= mask[i % 4];
    }
  }

  return {
    opcode,
    payload,
    bytesConsumed: offset + payloadLen,
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

export function createBridgeServer({
  bargeInOptions = { speechEnergyThreshold: 350, consecutiveSpeechFrames: 2 },
  carrier = "twilio",
} = {}) {
  const adapter = new CarrierFailoverAdapter({ primary: carrier });
  const ghostRouter = new GhostToolRouter();
  const wsSockets = new Set();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          status: "ok",
          service: "realtime-voice-ai-bridge",
          capabilities: ["dsp", "barge-in", "ghost-tools", "websocket-media-stream"],
          carrierDefault: carrier,
        }),
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/dsp/inbound") {
      try {
        const body = await readJsonBody(req);
        if (!body.payloadBase64) {
          res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "Missing payloadBase64" }));
          return;
        }
        const mulaw = Buffer.from(body.payloadBase64, "base64");
        const dsp = inboundToPcm16k(mulaw, {
          noiseGateAmplitude: body.noiseGateAmplitude ?? 100,
        });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            inputBytes: mulaw.length,
            outputPcm16kBytes: dsp.pcm16kBuffer.byteLength,
            meanAmplitude: Number(dsp.meanAmplitude.toFixed(2)),
            gatedToSilence: dsp.gatedToSilence,
          }),
        );
      } catch {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Invalid JSON payload" }));
      }
      return;
    }

    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.on("upgrade", (req, socket) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const wsKey = req.headers["sec-websocket-key"];
    if (url.pathname !== "/ws/media-stream" || typeof wsKey !== "string") {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    const acceptKey = crypto
      .createHash("sha1")
      .update(wsKey + WS_MAGIC_GUID)
      .digest("base64");

    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${acceptKey}`,
        "",
        "",
      ].join("\r\n"),
    );

    const bargeIn = new BargeInController(bargeInOptions);
    let streamId = "stream-default";
    let rxBuffer = Buffer.alloc(0);

    wsSockets.add(socket);
    socket.on("close", () => wsSockets.delete(socket));
    socket.on("end", () => socket.destroy());
    socket.on("error", () => {
      socket.destroy();
    });

    socket.on("data", (chunk) => {
      rxBuffer = Buffer.concat([rxBuffer, chunk]);

      while (true) {
        const frame = tryDecodeWsFrame(rxBuffer);
        if (!frame) break;
        rxBuffer = rxBuffer.subarray(frame.bytesConsumed);

        // 0x8 = Close frame
        if (frame.opcode === 0x8) {
          socket.end();
          return;
        }
        // 0x9 = Ping -> respond with Pong (0xA)
        if (frame.opcode === 0x9) {
          const pong = Buffer.concat([Buffer.from([0x8a, frame.payload.length]), frame.payload]);
          socket.write(pong);
          continue;
        }
        if (frame.opcode !== 0x1) continue;

        try {
          const raw = JSON.parse(frame.payload.toString("utf8"));
          const parsed = adapter.parseInboundMessage(raw);

          if (parsed.type === "start") {
            streamId = parsed.streamId || streamId;
            if (typeof raw.aiSpeaking === "boolean") {
              bargeIn.setAiSpeaking(raw.aiSpeaking);
            }
          } else if (parsed.type === "audio") {
            streamId = parsed.streamId || streamId;
            const dsp = inboundToPcm16k(parsed.mulawBytes);
            const hit = bargeIn.onInboundFrame({ meanAmplitude: dsp.meanAmplitude });
            if (hit.interrupted && hit.shouldClearBuffer) {
              const clearJson = adapter.buildClearFrame(carrier, streamId);
              socket.write(encodeWsTextFrame(clearJson));
            }
          } else if (parsed.type === "stop") {
            bargeIn.setAiSpeaking(false);
          }
        } catch {
          // Ignore malformed JSON frames without crashing the live media stream
        }
      }
    });
  });

  async function close() {
    for (const s of wsSockets) {
      s.destroy();
    }
    wsSockets.clear();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }

  return { server, adapter, ghostRouter, close };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const port = Number(process.env.PORT || 8080);
  const { server } = createBridgeServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(JSON.stringify({ event: "bridge_listening", url: `http://127.0.0.1:${port}` }));
  });
}
