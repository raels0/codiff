// @ts-check

/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { join, resolve } = require('node:path');

const packagePath = resolve(process.argv[2]);
const expectedArch = process.argv[3];
assert.ok(['arm64', 'x64'].includes(expectedArch), 'Specify the expected Windows architecture.');
assert.equal(process.platform, 'win32');
assert.equal(
  process.arch,
  expectedArch,
  'The packaged Electron runtime has the wrong architecture.',
);

const appRequire = createRequire(join(packagePath, 'resources', 'app', 'package.json'));
const keymap = appRequire('native-keymap/build/Release/keymapping.node');
assert.ok(
  Object.keys(keymap.getKeyMap()).length > 0,
  'The native keyboard module must load and run.',
);

const pty = appRequire('node-pty');
const marker = 'codiff-native-package-ok';
const terminal = pty.spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', `echo ${marker}`], {
  cols: 80,
  cwd: packagePath,
  rows: 24,
});
let output = '';
let timedOut = false;
const timeout = setTimeout(() => {
  timedOut = true;
  terminal.kill();
}, 15_000);
terminal.onData((/** @type {string} */ data) => {
  output += data;
});
terminal.onExit((/** @type {{ exitCode: number }} */ { exitCode }) => {
  clearTimeout(timeout);
  assert.equal(timedOut, false, 'The packaged native terminal must finish within 15 seconds.');
  assert.equal(exitCode, 0, 'The packaged native terminal must exit successfully.');
  assert.ok(output.includes(marker), 'The packaged native terminal must return its output.');
  console.log(`Verified Windows ${expectedArch}: Electron, keyboard mapping, and native terminal.`);
  // native-keymap keeps its keyboard-layout listener alive until the process exits.
  process.exit(0);
});
