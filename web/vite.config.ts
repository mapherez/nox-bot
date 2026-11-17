import { defineConfig, lazyPlugins } from "vite-plus";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: lazyPlugins(() => [react()]),
  server: {
    host: "127.0.0.1",
    proxy: { "/auth": "http://127.0.0.1:3200", "/dashboard/api": "http://127.0.0.1:3200" },
  },
  build: { sourcemap: false },
});
