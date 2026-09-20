// Turns the mascot's Blender file into public/mascot/deuz-mascot.glb.
//
//   npm run mascot:export -- path/to/mr.deuz.blend [--budget N] [--outline T] [--height H]
//
// Blender does the modelling side headlessly (tooling/export-mascot.py: strip the
// studio, decimate, two materials, outline, contract node names), then
// gltf-transform quantizes the result — KHR_mesh_quantization, which three.js
// reads natively — which takes a third off the file. Blender is found through
// $BLENDER, then PATH, then the default install folders.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '..', 'public', 'mascot', 'deuz-mascot.glb');
const [blend, ...options] = process.argv.slice(2);

if (!blend || !existsSync(blend)) {
  console.error('usage: npm run mascot:export -- path/to/mr.deuz.blend [--budget N] [--outline T] [--height H]');
  process.exit(2);
}

const blender = findBlender();
if (!blender) {
  console.error('Blender not found. Set BLENDER to the executable or put `blender` on PATH.');
  process.exit(1);
}

const scratch = mkdtempSync(join(tmpdir(), 'deuz-mascot-'));
try {
  const raw = join(scratch, 'raw.glb');
  run(blender, ['-b', resolve(blend), '--python', join(here, 'export-mascot.py'), '--', '--out', raw, ...options], {
    keep: /\[export-mascot\]|Error|Traceback|^\s+File /,
  });
  run(process.execPath, [npxCli(), '--yes', '@gltf-transform/cli@4', 'quantize', raw, out, '--quantize-position', '14', '--quantize-normal', '8'], {
    keep: /→/,
  });
  console.log(`${out}: ${Math.round(statSync(out).size / 1024)} KB`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

/** npx as a script for the current node, so no shell is involved on Windows. */
function npxCli() {
  const candidates = [
    process.env.npm_execpath && join(dirname(process.env.npm_execpath), 'npx-cli.js'),
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
  ].filter(Boolean);
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    console.error('npx not found next to node; run this through `npm run mascot:export`.');
    process.exit(1);
  }
  return found;
}

/** Run a tool, echoing only the lines that matter unless it fails. */
function run(command, args, { keep }) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const lines = output.split(/\r?\n/).filter((line) => line.trim());
  const failed = result.status !== 0 || result.error;
  for (const line of lines) if (failed || keep.test(line)) console.log(line);
  if (failed) {
    console.error(`${command} failed${result.error ? `: ${result.error.message}` : ` with exit code ${result.status}`}`);
    process.exit(result.status || 1);
  }
}

function findBlender() {
  if (process.env.BLENDER) return process.env.BLENDER;
  const lookup = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['blender'], { encoding: 'utf8' });
  if (lookup.status === 0 && lookup.stdout.trim()) return lookup.stdout.split(/\r?\n/)[0].trim();
  const roots =
    process.platform === 'win32'
      ? ['C:\\Program Files\\Blender Foundation']
      : process.platform === 'darwin'
        ? ['/Applications']
        : ['/opt', '/snap/bin', '/usr/local/bin'];
  const found = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      if (!/blender/i.test(entry)) continue;
      const executable =
        process.platform === 'win32'
          ? join(root, entry, 'blender.exe')
          : process.platform === 'darwin'
            ? join(root, entry, 'Contents', 'MacOS', 'Blender')
            : join(root, entry, 'blender');
      if (existsSync(executable)) found.push(executable);
    }
  }
  found.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return found.at(-1);
}
