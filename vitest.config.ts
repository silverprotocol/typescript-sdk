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
    // an EXCLUDE (not a root-relative include) so the file works whether vitest
    // is rooted here or pointed at from packages/e2e via
    // `--config ../../vitest.config.ts` (vitest 5 stopped resolving a parent
    // config, so the capture ritual passes the flag explicitly).
    exclude: [...configDefaults.exclude, "**/dist/**"],
    // The budget catches hangs; it does not time tests. On a busy fleet box
    // (load avg ~300 on 12 cores, 2026-09-23) the slowest ordinary test body,
    // provenance.test.ts's corpus walk, took 5.05 s: past vitest's 5 s
    // default. 30 s gives it 6x and sits far below CI's 15-minute test-job cap.
    // Vendor-SDK cold loads are NOT covered by this: they took up to 101.9 s
    // at that load, so the agents' run.smoke tests import statically (at
    // collection, which vitest does not time) instead of inside a test body.
    testTimeout: 30_000,
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
