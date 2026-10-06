import { readFile, writeFile, mkdir, chown } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Deployment identities, not application state. Keep this file on a private structural-secret volume. */
export async function provisionState({
  url,
  database,
  credentialFile,
  bundle,
  serviceCredentialFile,
}) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(database))
    throw new Error("Invalid database name.");
  let credentials;
  try {
    credentials = JSON.parse(await readFile(credentialFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT")
      throw new Error("State credentials could not be read.");
    const identity = async () => {
      const response = await fetch(`${url}/v1/identity`, { method: "POST" });
      if (!response.ok) throw new Error("Could not provision state identity.");
      const result = await response.json();
      if (
        typeof result.identity !== "string" ||
        typeof result.token !== "string"
      )
        throw new Error("Unexpected identity response.");
      return result;
    };
    credentials = { publisher: await identity(), service: await identity() };
    await mkdir(dirname(credentialFile), { recursive: true, mode: 0o700 });
    await writeFile(credentialFile, JSON.stringify(credentials), {
      mode: 0o600,
      flag: "wx",
    });
  }
  const headers = { Authorization: `Bearer ${credentials.publisher.token}` };
  const program = await readFile(bundle);
  // The same endpoint and host_type used by the pinned official CLI. Never request data deletion.
  const pre = await fetch(
    `${url}/v1/database/${database}/pre_publish?host_type=Js`,
    { method: "POST", headers, body: program },
  );
  if (pre.status !== 404) {
    if (!pre.ok)
      throw new Error(`State migration preflight failed (${pre.status}).`);
    const plan = await pre.json();
    if (
      !plan.AutoMigrate ||
      plan.AutoMigrate.break_clients ||
      plan.AutoMigrate.major_version_upgrade
    ) {
      throw new Error(
        "State schema update requires review; automatic destructive migrations are refused.",
      );
    }
  }
  const publish = await fetch(`${url}/v1/database/${database}?host_type=Js`, {
    method: "PUT",
    headers,
    body: program,
  });
  if (!publish.ok)
    throw new Error(`State module publication failed (${publish.status}).`);
  const { DbConnection } = await import("../dist/storage/bindings/index.js");
  const { Identity } = await import("spacetimedb");
  await new Promise((resolveAuthorization, rejectAuthorization) => {
    const timer = setTimeout(() => {
      connection.disconnect();
      rejectAuthorization(new Error("Service authorization timed out."));
    }, 10000);
    const connection = DbConnection.builder()
      .withUri(url)
      .withDatabaseName(database)
      .withToken(credentials.publisher.token)
      .onConnect(async (conn) => {
        try {
          await conn.reducers.authorizeService({
            identity: Identity.fromString(credentials.service.identity),
          });
          resolveAuthorization();
        } catch {
          rejectAuthorization(new Error("State service authorization failed."));
        } finally {
          clearTimeout(timer);
          conn.disconnect();
        }
      })
      .onConnectError(() => {
        clearTimeout(timer);
        rejectAuthorization(
          new Error("Could not connect to authorize the state service."),
        );
      })
      .build();
  });
  if (serviceCredentialFile) {
    await mkdir(dirname(serviceCredentialFile), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      serviceCredentialFile,
      JSON.stringify({ service: credentials.service }),
      { mode: 0o600 },
    );
    if (process.getuid?.() === 0) {
      await chown(dirname(serviceCredentialFile), 10001, 10001);
      await chown(serviceCredentialFile, 10001, 10001);
    }
  }
  return {
    token: credentials.service.token,
    identity: credentials.service.identity,
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const url = process.env.NOX_BOT_SPACETIMEDB_URL ?? "http://spacetimedb:3000";
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${url}/v1/ping`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      /* Server startup only; no application writes have been attempted. */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!ready)
    throw new Error(
      "SpacetimeDB did not become ready for controlled initialization.",
    );
  await provisionState({
    url,
    database: process.env.NOX_BOT_SPACETIMEDB_DATABASE ?? "nox-bot",
    credentialFile:
      process.env.NOX_BOT_STATE_CREDENTIAL_FILE ??
      "/run/nox-bot/state/credentials.json",
    bundle:
      process.env.NOX_BOT_STATE_BUNDLE ?? "/app/spacetimedb/dist/bundle.js",
    serviceCredentialFile: process.env.NOX_BOT_SERVICE_CREDENTIAL_FILE,
  });
  console.log("NoX Bot state module provisioned. Credentials remain private.");
}
