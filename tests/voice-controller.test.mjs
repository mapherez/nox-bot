import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:https";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { VoiceController } from "../dist/voice/controller.js";

async function certificates(t) {
  // Generate disposable test credentials under the repo. Never read installed credentials.
  const parent = resolve(".tmp");
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(join(parent, "voice-tls-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const openssl = (...args) => {
    const result = spawnSync("openssl", args, { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, "OpenSSL test fixture generation failed");
  };
  openssl(
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "ca.key",
    "-out",
    "ca.crt",
    "-days",
    "1",
    "-subj",
    "/CN=Test CA",
  );
  for (const name of ["server", "client", "wrong-host"]) {
    openssl(
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      `${name}.key`,
      "-out",
      `${name}.csr`,
      "-subj",
      `/CN=${name}`,
    );
    await writeFile(
      join(dir, `${name}.ext`),
      `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=${name === "client" ? "clientAuth" : "serverAuth"}\n${name === "client" ? "" : `subjectAltName=IP:${name === "server" ? "127.0.0.1" : "127.0.0.2"}\n`}`,
    );
    openssl(
      "x509",
      "-req",
      "-in",
      `${name}.csr`,
      "-CA",
      "ca.crt",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-out",
      `${name}.crt`,
      "-days",
      "1",
      "-extfile",
      `${name}.ext`,
    );
  }
  return dir;
}
async function server(t, dir, name = "server", handler) {
  const https = createServer(
    {
      key: await readFile(join(dir, `${name}.key`)),
      cert: await readFile(join(dir, `${name}.crt`)),
      ca: await readFile(join(dir, "ca.crt")),
      requestCert: true,
      rejectUnauthorized: true,
    },
    handler,
  );
  https.on("tlsClientError", () => {});
  await new Promise((resolve) => https.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        https.close(resolve);
        https.closeAllConnections();
      }),
  );
  return https;
}
function env(dir, port) {
  return {
    NOX_VOICE_CONTROLLER_URL: `https://127.0.0.1:${port}`,
    NOX_VOICE_CA_FILE: join(dir, "ca.crt"),
    NOX_VOICE_CLIENT_CERT_FILE: join(dir, "client.crt"),
    NOX_VOICE_CLIENT_KEY_FILE: join(dir, "client.key"),
  };
}
test("controller uses real mTLS for HTTP and audio, preserves settings, and never follows redirects", async (t) => {
  const dir = await certificates(t),
    seen = [];
  const https = await server(t, dir, "server", async (req, res) => {
    assert.equal(req.socket.authorized, true);
    seen.push([req.method, req.url]);
    if (req.url === "/api/diagnostics") {
      res.writeHead(302, { Location: "https://attacker.invalid" });
      res.end();
      return;
    }
    let value = {};
    if (req.method === "PUT") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      value = JSON.parse(Buffer.concat(chunks));
    } else if (req.url === "/api/engine/status")
      value = { state: "ready", conversationActive: false };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(value));
  });
  const ws = new WebSocketServer({ server: https, path: "/ws" });
  ws.on("connection", (socket) =>
    socket.on("message", (data) => socket.send(data)),
  );
  t.after(() => {
    for (const client of ws.clients) client.terminate();
    ws.close();
  });
  const controller = await VoiceController.fromEnvironment(
    env(dir, https.address().port),
  );
  assert.equal((await controller.status()).state, "ready");
  const settings = { voice: "NATM1", prompt: "Test", bits: 8 };
  assert.deepEqual(await controller.update(settings), settings);
  await assert.rejects(controller.diagnostics(), /rejected/);
  const socket = await controller.connect();
  t.after(() => socket.terminate());
  const message = once(socket, "message");
  socket.send(Buffer.alloc(7680));
  assert.equal((await message)[0].length, 7680);
  socket.terminate();
  assert.deepEqual(seen, [
    ["GET", "/api/engine/status"],
    ["PUT", "/api/settings"],
    ["GET", "/api/diagnostics"],
  ]);
});
test("controller rejects wrong hostname, invalid client identity, and malformed/unreadable key config", async (t) => {
  const dir = await certificates(t);
  let requests = 0;
  const wrong = await server(t, dir, "wrong-host", (_req, res) => {
    requests++;
    res.end("{}");
  });
  const wrongController = await VoiceController.fromEnvironment(
    env(dir, wrong.address().port),
  );
  await assert.rejects(wrongController.status(), /certificates/);
  assert.equal(requests, 0);
  const https = await server(t, dir, "server", (_req, res) => {
    requests++;
    res.end("{}");
  });
  const invalidIdentity = {
    ...env(dir, https.address().port),
    NOX_VOICE_CLIENT_CERT_FILE: join(dir, "server.crt"),
    NOX_VOICE_CLIENT_KEY_FILE: join(dir, "server.key"),
  };
  const client = await VoiceController.fromEnvironment(invalidIdentity);
  await assert.rejects(client.status(), /certificates/);
  assert.equal(requests, 0);
  await assert.rejects(
    VoiceController.fromEnvironment({
      ...env(dir, https.address().port),
      NOX_VOICE_CLIENT_KEY_FILE: join(dir, "missing.key"),
    }),
    /configuration is invalid/,
  );
});

test("readable malformed TLS keys are reported as optional voice configuration errors", async (t) => {
  const parent = resolve(".tmp");
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(join(parent, "voice-invalid-tls-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const file of ["ca.crt", "client.crt", "client.key"])
    await writeFile(join(dir, file), "invalid test fixture");
  await assert.rejects(
    VoiceController.fromEnvironment(env(dir, 8443)),
    /configuration is invalid/,
  );
});
