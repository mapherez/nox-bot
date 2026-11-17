import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    insertFinalNewline: true,
    endOfLine: "lf",
    useTabs: false,
    tabWidth: 2,
    sortPackageJson: false,
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
  },
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
