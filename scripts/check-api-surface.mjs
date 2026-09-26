#!/usr/bin/env node
/**
 * check-api-surface.mjs — the public-API snapshot gate.
 *
 *   node scripts/check-api-surface.mjs            # check every package against its snapshot
 *   node scripts/check-api-surface.mjs --write    # rewrite the snapshots (a reviewed act)
 *
 * For each published package, the entry's exports are listed with the TypeScript
 * compiler API, and each is recorded with its release tag (`@beta`, `@internal`,
 * else public) and its declaration text AS EMITTED to .d.ts (declaration emit runs
 * in memory; nothing is written). The declaration text carries a zod schema's
 * shape and a function's signature, so a renamed field or parameter is a change,
 * not only a renamed symbol. Snapshots live in api-surface/<package>.api.json.
 *
 * What fails (exit 1), per the 1.x policy's promise over PUBLIC symbols:
 *   - a public symbol ADDED (the snapshot must be updated deliberately with --write);
 *   - a public symbol REMOVED, or its declaration text CHANGED;
 *   - a symbol whose tag changed (a `@beta` symbol losing its tag is a public
 *     addition; a public symbol gaining `@beta` withdraws a promise).
 * What prints as a note only: an added, removed or changed `@beta` symbol, which
 * is outside the promise (it stays visible at every cut). `@internal` symbols are
 * listed so an accidental export shows, and treated like `@beta`.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ts = createRequire(join(root, "package.json"))("typescript");
const PACKAGES = ["core", "richtext", "claude-agent-sdk", "openai-agents", "google-adk", "vercel-ai"];
const SNAP_DIR = join(root, "api-surface");
// Cross-package imports resolve to each package's src through the root typecheck
// config's `paths`, never through a built dist/: the snapshot must not depend on
// whether a build ran first (CI runs this gate before any build).
const rootConfig = ts.getParsedCommandLineOfConfigFile(join(root, "tsconfig.json"), {}, {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: (d) => {
    throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  },
});
const SRC_PATHS = rootConfig.options.paths ?? {};
if (Object.keys(SRC_PATHS).length === 0) throw new Error("tsconfig.json declares no `paths` for the @silverprotocol packages");
const write = process.argv.includes("--write");

/** { name: { module, tag, decl: [text] } } for one package's entry exports. */
function surfaceOf(pkg) {
  const pkgDir = join(root, "packages", pkg);
  const parsed = ts.getParsedCommandLineOfConfigFile(join(pkgDir, "tsconfig.json"), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    },
  });
  const files = parsed.fileNames.filter((f) => !f.endsWith(".test.ts") && f.startsWith(join(pkgDir, "src")));
  const options = {
    ...parsed.options,
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
    declarationMap: false,
    sourceMap: false,
    composite: false,
    incremental: false,
    tsBuildInfoFile: undefined,
    skipLibCheck: true,
    outDir: join(pkgDir, "dist"),
    rootDir: join(root, "packages"),
    baseUrl: root,
    paths: SRC_PATHS,
  };
  const program = ts.createProgram(files, options);
  const checker = program.getTypeChecker();
  const dts = new Map(); // module basename → emitted d.ts text
  const emitted = program.emit(
    undefined,
    (fileName, text, _bom, _onError, sources) => {
      const own = (sources ?? []).some((s) => s.fileName.startsWith(join(pkgDir, "src")));
      if (fileName.endsWith(".d.ts") && own) dts.set(basename(fileName, ".d.ts"), text);
    },
    undefined,
    true,
  );
  if (emitted.emitSkipped) throw new Error(`${pkg}: declaration emit was skipped`);

  // Declaration statements per module, by exported name.
  const printer = ts.createPrinter({ removeComments: true });
  const byModule = new Map();
  for (const [mod, text] of dts) {
    const sf = ts.createSourceFile(`${mod}.d.ts`, text, ts.ScriptTarget.Latest, true);
    const names = new Map();
    // Every top-level declaration by name, exported inline or through an
    // `export { … }` list: the checker, not the modifier, decides what's public.
    for (const st of sf.statements) {
      if (ts.isExportDeclaration(st) || ts.isImportDeclaration(st) || ts.isExportAssignment(st)) continue;
      const declared = ts.isVariableStatement(st)
        ? st.declarationList.declarations.map((d) => d.name.getText(sf))
        : st.name !== undefined
          ? [st.name.getText(sf)]
          : [];
      const code = printer.printNode(ts.EmitHint.Unspecified, st, sf).trim();
      for (const n of declared) names.set(n, [...(names.get(n) ?? []), code]);
    }
    byModule.set(mod, names);
  }

  const entry = program.getSourceFile(join(pkgDir, "src", "index.ts"));
  const moduleSymbol = checker.getSymbolAtLocation(entry);
  const surface = {};
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const name = exported.getName();
    const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const decls = target.declarations ?? [];
    if (decls.length === 0) throw new Error(`${pkg}: export ${name} resolves to no declaration (an unresolved import?)`);
    const tags = new Set(decls.flatMap((d) => ts.getJSDocTags(d).map((t) => t.tagName.text)));
    const tag = tags.has("internal") ? "internal" : tags.has("beta") ? "beta" : "public";
    const sourceFile = decls[0].getSourceFile().fileName;
    if (!sourceFile.startsWith(join(pkgDir, "src"))) {
      // A re-export from another package (e.g. a facet re-exporting a core type):
      // its shape is governed by that package's own snapshot; record the edge.
      const sibling = /\/packages\/([^/]+)\/src\//.exec(sourceFile)?.[1];
      const from = sibling !== undefined ? `@silverprotocol/${sibling}` : /node_modules\/(@[^/]+\/[^/]+|[^/]+)\//.exec(sourceFile)?.[1];
      if (from === undefined) throw new Error(`${pkg}: cannot name the package that declares ${name} (${sourceFile})`);
      surface[name] = { module: from, tag, decl: [`export { ${target.getName()} } from "${from}"`] };
      continue;
    }
    const mod = basename(sourceFile, ".ts");
    const decl = byModule.get(mod)?.get(target.getName()) ?? [];
    if (decl.length === 0) throw new Error(`${pkg}: no emitted declaration for ${name} (module ${mod})`);
    surface[name] = { module: mod, tag, decl };
  }
  return Object.fromEntries(Object.entries(surface).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

let failures = 0;
const lines = [];
for (const pkg of PACKAGES) {
  const now = surfaceOf(pkg);
  const snapPath = join(SNAP_DIR, `${pkg}.api.json`);
  if (write) {
    mkdirSync(SNAP_DIR, { recursive: true });
    writeFileSync(snapPath, JSON.stringify(now, null, 2) + "\n");
    lines.push(`✎ ${pkg}: ${Object.keys(now).length} exports written to api-surface/${pkg}.api.json`);
    continue;
  }
  if (!existsSync(snapPath)) {
    failures++;
    lines.push(`✗ ${pkg}: no snapshot (api-surface/${pkg}.api.json); run with --write and review it`);
    continue;
  }
  const then = JSON.parse(readFileSync(snapPath, "utf8"));
  const pkgLines = [];
  for (const name of new Set([...Object.keys(then), ...Object.keys(now)])) {
    const a = then[name];
    const b = now[name];
    const promised = (a?.tag ?? "public") === "public" || (b?.tag ?? "public") === "public";
    let what;
    if (a === undefined) what = `added (${b.tag})`;
    else if (b === undefined) what = `removed (${a.tag})`;
    else if (a.tag !== b.tag) what = `tag ${a.tag} → ${b.tag}`;
    else if (JSON.stringify(a.decl) !== JSON.stringify(b.decl)) what = `declaration changed (${b.tag})`;
    if (what === undefined) continue;
    const fails = a !== undefined && b !== undefined && a.tag !== b.tag ? true : promised;
    if (fails) failures++;
    pkgLines.push(`  ${fails ? "✗" : "•"} ${name}: ${what}`);
  }
  lines.push(`${pkgLines.some((l) => l.startsWith("  ✗")) ? "✗" : "✓"} ${pkg}: ${Object.keys(now).length} exports`, ...pkgLines);
}
console.log(lines.join("\n"));
if (failures > 0) {
  console.error(
    `\n${failures} public-API change(s). A deliberate change updates the snapshot with --write and is reviewed like any public-API change.`,
  );
  process.exit(1);
}
