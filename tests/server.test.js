import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import crypto from "node:crypto";

import { createBridgeServer } from "../src/server.js";

function encodeWsTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(6);
    header[0] = 0x81; // FIN + text opcode
    header[1] = 0x80 | payload.length; // Masked
    mask.copy(header, 2);
  } else {
    header = Buffer.alloc(8);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
    mask.copy(header, 4);
  }
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) {
    masked[i] = payload[i] ^ mask[i % 4];
  }
  return Buffer.concat([header, masked]);
}

function decodeWsServerFrame(buf) {
  if (buf.length < 2) return null;
  const secondByte = buf[1];
  let len = secondByte & 0x7f;
  let offset = 2;
  if (len === 126) {
    len = buf.readUInt16BE(2);
    offset = 4;
  }
  if (buf.length < offset + len) return null;
  return buf.subarray(offset, offset + len).toString("utf8");
}

test("Bridge HTTP/WebSocket server exposes /health and handles live WebSocket barge-in", async () => {
  const { server, close } = createBridgeServer({
    bargeInOptions: { speechEnergyThreshold: 350, consecutiveSpeechFrames: 2 },
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = await healthRes.json();
    assert.equal(healthJson.status, "ok");
    assert.equal(healthJson.service, "realtime-voice-ai-bridge");

    const loudMulawB64 = Buffer.alloc(160, 0x10).toString("base64");
    const dspRes = await fetch(`http://127.0.0.1:${port}/v1/dsp/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payloadBase64: loudMulawB64 }),
    });
    assert.equal(dspRes.status, 200);
    const dspJson = await dspRes.json();
    assert.equal(dspJson.inputBytes, 160);
    assert.equal(dspJson.outputPcm16kBytes, 640);
    assert.equal(dspJson.gatedToSilence, false);

    // Raw RFC 6455 WebSocket client upgrade test (zero dependencies)
    const wsKey = crypto.randomBytes(16).toString("base64");
    const responsePayload = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
        socket.write(
          [
            "GET /ws/media-stream HTTP/1.1",
            `Host: 127.0.0.1:${port}`,
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Key: ${wsKey}`,
            "Sec-WebSocket-Version: 13",
            "",
            "",
          ].join("\r\n"),
        );
      });

      let upgraded = false;
      let buffer = Buffer.alloc(0);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("WebSocket barge-in test timed out"));
      }, 3000);

      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (!upgraded) {
          const str = buffer.toString("utf8");
          const endIdx = str.indexOf("\r\n\r\n");
          if (endIdx !== -1) {
            assert.ok(str.includes("101 Switching Protocols"));
            upgraded = true;
            buffer = buffer.subarray(endIdx + 4);

            // Simulate active AI speech + two high-energy Mu-Law frames (byte 0x10 ~ loud amplitude)
            const loudMulaw = Buffer.alloc(160, 0x10).toString("base64");
            socket.write(
              encodeWsTextFrame(JSON.stringify({ event: "start", streamSid: "STR-99", aiSpeaking: true })),
            );
            socket.write(
              encodeWsTextFrame(JSON.stringify({ event: "media", streamSid: "STR-99", media: { payload: loudMulaw } })),
            );
            socket.write(
              encodeWsTextFrame(JSON.stringify({ event: "media", streamSid: "STR-99", media: { payload: loudMulaw } })),
            );
          }
          return;
        }

        const decoded = decodeWsServerFrame(buffer);
        if (decoded) {
          clearTimeout(timer);
          socket.destroy();
          resolve(JSON.parse(decoded));
        }
      });

      socket.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    assert.equal(responsePayload.event, "clear");
    assert.equal(responsePayload.streamSid, "STR-99");
  } finally {
    await close();
  }
});
