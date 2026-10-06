// Fault injection for the real worker: swallow dispose and ignore graceful termination.
const emit = process.emit;
process.emit = function (event, message, ...args) {
  if (event === "message" && message?.type === "dispose") return true;
  return emit.call(this, event, message, ...args);
};
process.on("SIGTERM", () => {});
