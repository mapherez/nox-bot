import type { PluginRuntime } from "../sdk.js";
const runtime: PluginRuntime = {
  handlers: {
    ping: async (context) => ({
      content: `🏓 Pong! Latency: ${Math.round(context.latencyMs)}ms`,
    }),
  },
};
export default runtime;
