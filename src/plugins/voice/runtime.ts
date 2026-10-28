// The voice capability is hosted by the core audio service, never by a worker.
import type { PluginRuntime } from "../sdk.js";
const runtime: PluginRuntime = { handlers: {} };
export default runtime;
