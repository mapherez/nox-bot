import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fork } from "node:child_process";
import weather from "../dist/plugins/weather/runtime.js";
import dictionary from "../dist/plugins/dictionary/runtime.js";
import { validateRichContent } from "../dist/plugins/richContent.js";
import { builtInPlugins } from "../dist/plugins/catalog.js";
import { memoryState } from "./fixtures/state.mjs";
const context = {
  guildId: "1",
  user: { id: "7" },
  command: "weather",
  options: {},
  users: {},
  settings: { units: "celsius", defaultLocation: "London" },
  secrets: { apiKey: "fixture-key" },
  latencyMs: 12,
};
test(
  "persistent worker crashes exhaust three retries and confirmed disable/enable resets recovery",
  { timeout: 16000 },
  async (t) => {
    const launches = [];
    let fail = false;
    const { state, plugins } = await memoryState(t, (file, args, options) => {
      const child = fork(file, args, options);
      launches.push(Date.now());
      if (fail) child.once("spawn", () => child.kill("SIGKILL"));
      return child;
    });
    await plugins.setEnabled("ping", "1", true, "0");
    fail = true;
    const crash = Date.now();
    process.kill(plugins.runtimeStatus("ping").pid, "SIGKILL");
    const deadline = Date.now() + 11000;
    while (
      (launches.length < 4 ||
        plugins.runtimeStatus("ping").state !== "error") &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(launches.length, 4);
    assert.equal(plugins.runtimeStatus("ping").state, "error");
    assert.ok(launches[1] - crash >= 950);
    assert.ok(launches[2] - launches[1] >= 1950);
    assert.ok(launches[3] - launches[2] >= 3950);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(launches.length, 4);
    fail = false;
    await plugins.setEnabled(
      "ping",
      "1",
      false,
      state.get("plugin", "1", "ping").revision,
    );
    await plugins.setEnabled(
      "ping",
      "1",
      true,
      state.get("plugin", "1", "ping").revision,
    );
    assert.equal(launches.length, 5);
    assert.equal(plugins.runtimeStatus("ping").state, "active");
  },
);
test(
  "last disable force-terminates a real worker that ignores dispose and SIGTERM",
  { timeout: 6000 },
  async (t) => {
    const { state, plugins } = await memoryState(t, (file, args, options) =>
      fork(file, args, {
        ...options,
        execArgv: [
          "--import=" +
            new URL("./fixtures/worker-stubborn.mjs", import.meta.url).href,
        ],
      }),
    );
    await plugins.setEnabled("ping", "1", true, "0");
    const pid = plugins.runtimeStatus("ping").pid;
    await plugins.setEnabled(
      "ping",
      "1",
      false,
      state.get("plugin", "1", "ping").revision,
    );
    assert.equal(plugins.runtimeStatus("ping").state, "inactive");
    assert.throws(() => process.kill(pid, 0));
  },
);
test("Weather uses confirmed preferences, HTTPS, units and a private refresh action with safe upstream errors", async (t) => {
  const calls = [];
  const requests = mock.method(globalThis, "fetch", async (url, options) => {
    calls.push([String(url), options]);
    return String(url).includes("/geo/")
      ? new Response(
          JSON.stringify([{ lat: 51, lon: 0, name: "London", country: "GB" }]),
        )
      : new Response(
          JSON.stringify({
            name: "London",
            sys: { country: "GB" },
            weather: [{ description: "clear sky", icon: "01d" }],
            main: { temp: 18, feels_like: 17, humidity: 45, pressure: 1010 },
            wind: { speed: 3 },
            visibility: 10000,
          }),
        );
  });
  t.after(() => requests.mock.restore());
  const result = await weather.handlers.weather(context);
  validateRichContent(result, builtInPlugins[0]);
  assert.match(calls[0][0], /^https:/);
  assert.match(calls[1][0], /units=metric/);
  assert.equal(result.components[0].action, "refresh");
  assert.ok(calls.every(([, options]) => options.signal));
  const refresh = await weather.components.refresh({
    ...context,
    settings: { units: "fahrenheit", defaultLocation: "London" },
  });
  validateRichContent(refresh, builtInPlugins[0]);
  assert.match(calls.at(-1)[0], /units=imperial/);
  requests.mock.mockImplementation(
    async () => new Response("{}", { status: 401 }),
  );
  const unavailable = await weather.handlers.weather(context);
  assert.equal(JSON.stringify(unavailable).includes("fixture-key"), false);
});
test("Dictionary corrects accents using real native assets, attaches Priberam images and falls back safely", async (t) => {
  let requestedWord = "";
  const requests = mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith(".png"))
      return new Response(new Uint8Array([1, 2, 3]));
    requestedWord = decodeURIComponent(String(url).split("/").at(-1));
    return new Response(
      '<html><img class="imagemdef" src="/definition.png"><div class="def">A Portuguese definition.</div></html>',
    );
  });
  t.after(() => {
    requests.mock.restore();
    return dictionary.dispose();
  });
  const result = await dictionary.handlers.definition({
    ...context,
    command: "definition",
    options: { word: "coracao" },
    settings: {},
    secrets: {},
  });
  assert.equal(requestedWord, "coração");
  assert.equal(result.attachments.length, 1);
  validateRichContent(result, builtInPlugins[1]);
  requests.mock.mockImplementation(
    async () => new Response('<div class="def">Text fallback</div>'),
  );
  const fallback = await dictionary.handlers.definition({
    ...context,
    options: { word: "coração" },
    settings: {},
    secrets: {},
  });
  assert.match(fallback.embeds[0].description, /Text fallback/);
  assert.equal(fallback.attachments, undefined);
});
test("Core rejects undeclared interactive/attachment capabilities and arbitrary reply flags", () => {
  assert.throws(() =>
    validateRichContent({ content: "unsafe", flags: 0 }, builtInPlugins[3]),
  );
  assert.throws(() =>
    validateRichContent(
      {
        content: "unsafe",
        components: [{ kind: "button", action: "refresh", label: "Refresh" }],
      },
      builtInPlugins[3],
    ),
  );
  assert.throws(() =>
    validateRichContent(
      {
        content: "unsafe",
        attachments: [{ name: "x.txt", data: new Uint8Array([1]) }],
      },
      builtInPlugins[3],
    ),
  );
  assert.throws(() =>
    validateRichContent(
      { embeds: [{ description: "x".repeat(4097) }] },
      builtInPlugins[0],
    ),
  );
});
test(
  "shared process recovers from a crash while DB is offline and confirmed commands remain available",
  { timeout: 10000 },
  async (t) => {
    const { state, plugins, disconnect } = await memoryState(t);
    await plugins.setEnabled("ping", "1", true, "0");
    const previous = plugins.runtimeStatus("ping").pid;
    disconnect();
    process.kill(previous, "SIGKILL");
    const deadline = Date.now() + 5000;
    while (
      (plugins.runtimeStatus("ping").pid === previous ||
        plugins.runtimeStatus("ping").state !== "active") &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(plugins.runtimeStatus("ping").state, "active");
    assert.notEqual(plugins.runtimeStatus("ping").pid, previous);
    assert.equal(plugins.commandsAvailable("ping", "1"), true);
    assert.equal(state.writable, false);
    assert.match(
      (
        await plugins.execute("ping", "ping", {
          ...context,
          options: {},
          settings: undefined,
          secrets: undefined,
        })
      ).content,
      /Pong/,
    );
  },
);
