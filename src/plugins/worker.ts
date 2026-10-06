import { pathToFileURL } from "node:url";
import { isRecord } from "../core/state.js";
import type { ChildMessage, ParentMessage, PluginRuntime } from "./sdk.js";
let runtime: PluginRuntime | undefined;
const guilds = new Set<string>();
function send(message: ChildMessage): void {
  process.send?.(message);
}
function isRuntime(value: unknown): value is PluginRuntime {
  return (
    isRecord(value) &&
    isRecord(value.handlers) &&
    Object.values(value.handlers).every(
      (handler) => typeof handler === "function",
    ) &&
    ["components", "autocomplete"].every(
      (key) =>
        value[key] === undefined ||
        (isRecord(value[key]) &&
          Object.values(value[key]).every(
            (handler) => typeof handler === "function",
          )),
    ) &&
    ["activate", "configure", "dispose"].every(
      (key) => value[key] === undefined || typeof value[key] === "function",
    )
  );
}
process.on("message", (input: unknown) => {
  if (
    !isRecord(input) ||
    typeof input.requestId !== "string" ||
    typeof input.type !== "string"
  )
    return;
  // IPC originates only from the typed supervisor. Runtime definitions are checked before activation.
  const message = input as unknown as ParentMessage;
  void (async () => {
    switch (message.type) {
      case "initialize": {
        const loaded: { default?: unknown } = await import(
          pathToFileURL(message.entry).href
        );
        const candidate = loaded.default;
        if (!isRuntime(candidate))
          throw new Error("Invalid plugin runtime contract.");
        if (
          message.handlers.some(
            (handler) => typeof candidate.handlers[handler] !== "function",
          )
        )
          throw new Error(
            "Runtime command handlers do not match its definition.",
          );
        if (
          message.componentHandlers.some(
            (handler) => typeof candidate.components?.[handler] !== "function",
          )
        )
          throw new Error(
            "Runtime component handlers do not match its definition.",
          );
        runtime = candidate;
        await runtime.activate?.();
        message.guilds.forEach((id) => guilds.add(id));
        await runtime.configure?.([...guilds]);
        send({ type: "result", requestId: message.requestId });
        break;
      }
      case "configure":
        guilds.clear();
        message.guilds.forEach((id) => guilds.add(id));
        await runtime?.configure?.([...guilds]);
        send({ type: "result", requestId: message.requestId });
        break;
      case "execute":
      case "component":
      case "autocomplete": {
        if (!runtime || !guilds.has(message.context.guildId))
          throw new Error("Plugin is not enabled in this server.");
        const handlers =
          message.type === "execute"
            ? runtime.handlers
            : message.type === "component"
              ? runtime.components
              : runtime.autocomplete;
        const handler = handlers?.[message.handler];
        if (!handler) throw new Error("Unknown plugin handler.");
        const value = await handler(message.context);
        send({ type: "result", requestId: message.requestId, value });
        break;
      }
      case "dispose":
        await runtime?.dispose?.();
        runtime = undefined;
        guilds.clear();
        send({ type: "result", requestId: message.requestId });
        break;
    }
  })().catch(() =>
    send({
      type: "error",
      requestId: message.requestId,
      message: "Plugin operation failed. Please try again.",
    }),
  );
});
process.on("disconnect", () => {
  void runtime?.dispose?.().finally(() => process.exit());
  if (!runtime?.dispose) process.exit();
});
