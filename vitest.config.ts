import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Resolve workspace packages by name to their local source, so cross-package
// imports (e.g. @silverprotocol/core) work WITHOUT a pnpm install — the SDK is
// co-developed inside the guuey tree under the no-install discipline (see the S2
// plan). tsc resolves the same names via each package's tsconfig `paths`.
export default defineConfig({
  resolve: {
    alias: {
      "@silverprotocol/core": fileURLToPath(
        new URL("./packages/core/src/index.ts", import.meta.url),
      ),
      "@silverprotocol/claude-agent-sdk": fileURLToPath(
        new URL("./packages/claude-agent-sdk/src/index.ts", import.meta.url),
      ),
    },
  },
});
