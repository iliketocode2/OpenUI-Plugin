import { runTests } from '@vscode/test-electron';
import * as esbuild from 'esbuild';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = join(root, 'out', 'integration');
const suiteDir = join(root, 'test', 'integration', 'suite');

await rm(outDir, { recursive: true, force: true });
const entries = (await readdir(suiteDir)).filter((f) => f.endsWith('.ts')).map((f) => join(suiteDir, f));
await esbuild.build({
  entryPoints: entries,
  outdir: outDir,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode', 'mocha'],
  sourcemap: true,
  logLevel: 'warning',
});

// VS Code is given the workspace through a link, as happens on CI runners and real machines (macOS /var →
// /private/var, Windows 8.3 names such as RUNNER~1), so path-display bugs show up locally too.
const workspaceBase = await mkdtemp(join(tmpdir(), 'owui agent workspace '));
await mkdir(join(workspaceBase, 'real'));
const workspace = join(workspaceBase, 'opened via link');
await symlink(join(workspaceBase, 'real'), workspace, process.platform === 'win32' ? 'junction' : 'dir');
await writeFile(join(workspace, 'README.md'), '# Integration workspace\n');
const userData = await mkdtemp(join(tmpdir(), 'owui-agent-user-'));

delete process.env.ELECTRON_RUN_AS_NODE;
delete process.env.VSCODE_IPC_HOOK_CLI;

let code = 1;
try {
  code = await runTests({
    version: process.env.VSCODE_TEST_VERSION ?? '1.96.0',
    vscodeExecutablePath: process.env.VSCODE_TEST_PATH,
    extensionDevelopmentPath: process.env.OWUI_TEST_EXTENSION_PATH ?? root,
    extensionTestsPath: join(outDir, 'index.js'),
    extensionTestsEnv: { OWUI_AGENT_INTEGRATION: '1' },
    launchArgs: [
      workspace,
      '--disable-extensions',
      '--disable-workspace-trust',
      `--user-data-dir=${userData}`,
      '--skip-welcome',
      '--skip-release-notes',
      // Ubuntu 24.04 runners restrict the unprivileged user namespaces Electron's sandbox needs.
      ...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []),
    ],
  });
} catch (e) {
  console.error(e);
} finally {
  await rm(workspaceBase, { recursive: true, force: true }).catch(() => undefined);
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
}
process.exit(code);
