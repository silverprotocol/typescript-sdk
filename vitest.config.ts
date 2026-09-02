import { configDefaults, defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Resolve workspace packages by name to their local source, so cross-package
// imports (e.g. @silverprotocol/core) work WITHOUT a pnpm install — the SDK is
// co-developed inside the guuey tree under the no-install discipline (see the S2
// plan). tsc resolves the same names via each package's tsconfig `paths`.
export default defineConfig({
  test: {
    // Vitest 4 dropped `**/dist/**` from its default exclude list, and every
    // package's tsc build emits its *.test.ts alongside src (package.json
    // `files` strips them from the tarball). Re-add the exclusion so a local
    // `tsc -b` cannot double-run the compiled copies under the alias. Kept as
    // an EXCLUDE (not a root-relative include) because the capture ritual runs
    // `npx vitest run src/capture-cli.test.ts` from packages/e2e and vitest
    // resolves this parent config there too.
    exclude: [...configDefaults.exclude, "**/dist/**"],
  },
  resolve: {
    alias: {
      "@silverprotocol/core": fileURLToPath(
        new URL("./packages/core/src/index.ts", import.meta.url),
      ),
      "@silverprotocol/claude-agent-sdk": fileURLToPath(
        new URL("./packages/claude-agent-sdk/src/index.ts", import.meta.url),
      ),
      "@silverprotocol/openai-agents": fileURLToPath(
        new URL("./packages/openai-agents/src/index.ts", import.meta.url),
      ),
      "@silverprotocol/google-adk": fileURLToPath(
        new URL("./packages/google-adk/src/index.ts", import.meta.url),
      ),
      "@silverprotocol/vercel-ai": fileURLToPath(
        new URL("./packages/vercel-ai/src/index.ts", import.meta.url),
      ),
    },
  },
});
