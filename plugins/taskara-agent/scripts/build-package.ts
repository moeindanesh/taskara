#!/usr/bin/env bun
/**
 * Build the publishable npm package into `dist/`.
 *
 * The package is a **build artifact with its own generated manifest**, not this directory with a
 * flag flipped. That is deliberate: `plugins/taskara-agent` depends on `@taskara/shared` through
 * `workspace:*`, which npm cannot resolve, so publishing it as-is would mean either publishing
 * `@taskara/shared` too — a second package to version in lockstep, for code nobody imports directly
 * — or rewriting the manifest at publish time, which makes the thing you ship differ from the thing
 * in the tree with no record of how.
 *
 * Bundling settles it. `@taskara/shared` is inlined, and so is every other dependency, so the
 * published package has **no `dependencies` at all** — nothing to resolve, nothing to conflict, and
 * no lockfile in the consumer that this can perturb.
 *
 * `bin` in the repo still points at `src/`, so `bun link` and `bun run agent:login` keep working
 * against the sources with no build step. The build is only for people who do not have the repo.
 */
import { mkdirSync, rmSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PLUGIN_DIR = join(import.meta.dir, '..');
const DIST = join(PLUGIN_DIR, 'dist');
const source = JSON.parse(await Bun.file(join(PLUGIN_DIR, 'package.json')).text());

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

for (const [entry, out] of [['src/cli.ts', 'cli.js'], ['src/mcp-server.ts', 'mcp-server.js']]) {
  const built = await Bun.build({
    entrypoints: [join(PLUGIN_DIR, entry)],
    outdir: DIST,
    target: 'bun',
    naming: out
  });
  if (!built.success) {
    for (const log of built.logs) console.error(log);
    process.exit(1);
  }
}

// A shebang, so the bin is executable rather than only importable.
for (const file of ['cli.js', 'mcp-server.js']) {
  const path = join(DIST, file);
  const body = await Bun.file(path).text();
  if (!body.startsWith('#!')) writeFileSync(path, `#!/usr/bin/env bun\n${body}`);
}

writeFileSync(
  join(DIST, 'package.json'),
  `${JSON.stringify(
    {
      name: 'taskara',
      version: source.version,
      description: 'The Taskara CLI and MCP server: an issue tracker an agent can drive.',
      type: 'module',
      bin: { taskara: './cli.js', 'taskara-mcp': './mcp-server.js' },
      files: ['cli.js', 'mcp-server.js', 'README.md', 'LICENSE'],
      engines: { bun: '>=1.0.0' },
      license: source.license ?? 'MIT',
      repository: { type: 'git', url: 'git+https://github.com/moeindanesh/taskara.git' },
      keywords: ['taskara', 'issue-tracker', 'agent', 'mcp', 'cli']
      // No `dependencies`: everything is bundled. See the note at the top of build-package.ts.
    },
    null,
    2
  )}\n`
);

const readme = join(PLUGIN_DIR, 'README.npm.md');
if (existsSync(readme)) copyFileSync(readme, join(DIST, 'README.md'));

// The licence lives at the repository root and is copied rather than duplicated, so the published
// package and the repository can never claim different terms. npm would include a LICENSE it finds
// regardless of `files`, but only if one is actually here — and `dist/` is generated from nothing.
const licence = join(PLUGIN_DIR, '..', '..', 'LICENSE');
if (!existsSync(licence)) {
  console.error('✗ No LICENSE at the repository root, but the manifest claims one.');
  process.exit(1);
}
copyFileSync(licence, join(DIST, 'LICENSE'));

const sizes = await Promise.all(
  ['cli.js', 'mcp-server.js'].map(async (f) => `${f} ${Math.round((await Bun.file(join(DIST, f)).size) / 1024)}KB`)
);
console.log(`built dist/ — ${sizes.join(', ')}, 0 dependencies

  cd ${DIST} && npm pack        # inspect the tarball
  cd ${DIST} && npm publish     # when you mean it
`);
