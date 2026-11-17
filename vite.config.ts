import type { FormatConfig } from "vite-plus/fmt";
import formatOptions from "./scripts/format-options.json" with { type: "json" };
import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: formatOptions as FormatConfig,
  staged: { "*": "vp check --fix" },
  lint: {
    ignorePatterns: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/target/**",
      "**/vendor/**",
      "**/*.md",
      "**/*.mdx",
      "**/package-lock.json",
      "**/pnpm-lock.yaml",
    ],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
});
