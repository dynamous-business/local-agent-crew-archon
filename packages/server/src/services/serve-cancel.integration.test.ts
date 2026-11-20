import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileAsync } from '@archon/git';
import { trackTempRoots } from '@archon/paths/test-utils';

const trackTempRoot = trackTempRoots();
// The grandchild lives until released by a marker file, so no wall-clock budget can be
// consumed by slow starts. This outer bound only guarantees an orphan eventually exits.
const GRANDCHILD_MAX_LIFE_MS = 30_000;
const GRANDCHILD_POLL_MS = 100;
// Cancel is cooperative: the route answers 200 after the DB transition, and the node's
// subprocess poll (SUBPROCESS_STOP_CHECK_INTERVAL_MS = 1 s in dag/run-control.ts) plus
// taskkill end the tree shortly after. Wait past that before probing a survivor, or a
// correct-but-slow kill could lose to the release probe itself.
const TREE_KILL_GRACE_MS = 4_000;
// A survivor was released at the same instant as the control, so it writes its marker
// within about one poll interval. This grace is ~20x that interval.
const LEAK_ASSERT_GRACE_MS = 2_000;
// Two in-place runs in one checkout serialize, so each run gets its own project and source.
const SOURCES = ['first', 'second'] as const;

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

test('cancelling a run under archon serve ends its script node tree and no other run', async () => {
  const root = trackTempRoot(await realpath(mkdtempSync(join(tmpdir(), 'archon-serve-cancel-'))));
  const home = join(root, 'home');
  const markers = join(root, 'markers');
  await mkdir(home);
  await mkdir(markers);
  await writeFile(join(home, 'config.yaml'), 'defaultAssistant: claude\n');
  const grandchild = join(root, 'grandchild.js');
  await writeFile(
    grandchild,
    `const { writeFileSync, existsSync } = require('node:fs');
writeFileSync(process.argv[2], '');
const [release, leaked, maxLifeMs, pollMs] = [3, 4, 5, 6].map(i => process.argv[i]);
const deadline = Date.now() + Number(maxLifeMs);
const poll = () => {
  if (existsSync(release)) { writeFileSync(leaked, ''); return; }
  if (Date.now() >= deadline) process.exit(1);
  setTimeout(poll, Number(pollMs));
};
poll();\n`
  );
  const modulePath = join(root, 'plugin.mjs');
  await writeFile(
    modulePath,
    `export default ({ sourceInstanceId, config }) => ({
      async receive(request) {
        return { status: 'received', acceptance: {
          receipt: { id: crypto.randomUUID(), sourceInstanceId, deliveryId: 'cancel',
            contentDigest: 'sha256:cancel', receivedAt: request.receivedAt,
            occurredAt: null, sourceActor: null },
          outcome: 'matched', bindings: [config.binding]
        }};
      }
    });\n`
  );
  const sources = [];
  for (const name of SOURCES) {
    const project = join(root, name);
    await mkdir(join(project, '.archon', 'workflows'), { recursive: true });
    // The node waits on a grandchild, so only ending the node's whole tree stops its marker.
    await writeFile(
      join(project, '.archon', 'workflows', 'hosted.yaml'),
      `name: hosted
description: Serve cancel test.
nodes:
  - id: hang
    runtime: bun
    script: |
      import { spawn } from 'node:child_process';
      import { join } from 'node:path';
      const marker = name => join(${JSON.stringify(markers)}, process.env.WORKFLOW_ID + '.' + name);
      const child = spawn(process.execPath, [${JSON.stringify(grandchild)}, marker('started'), marker('release'), marker('leaked'), ${String(GRANDCHILD_MAX_LIFE_MS)}, ${String(GRANDCHILD_POLL_MS)}], { stdio: 'ignore' });
      await new Promise(resolve => child.once('exit', resolve));
`
    );
    // A resource start runs only in a registered repository.
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: project });
    sources.push({
      sourceInstanceId: name,
      module: modulePath,
      config: {
        binding: {
          bindingId: name,
          bindingRevision: null,
          hostId: 'server-host',
          runAsUserId: '22222222-2222-4222-8222-222222222222',
          resource: `repo:${name}`,
          capacity: 1,
          overlap: 'queue',
          launch: {
            cwd: project,
            workflowName: 'hosted',
            inputs: {},
            isolation: { kind: 'in-place' },
          },
        },
      },
    });
  }
  const configPath = join(root, 'sources.json');
  await writeFile(configPath, JSON.stringify({ version: 1, sources }));

  const server = spawn(
    process.execPath,
    [join(import.meta.dir, 'fixtures/setup-shutdown-server.ts'), root],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ARCHON_HOME: home,
        DATABASE_URL: '',
        ARCHON_TELEMETRY_DISABLED: '1',
        HOST: '127.0.0.1',
        ARCHON_TRIGGER_HOST: 'server-host',
        ARCHON_WEBHOOK_SOURCES: configPath,
      },
    }
  );
  let output = '';
  server.stdout?.on('data', chunk => {
    output += String(chunk);
  });
  server.stderr?.on('data', chunk => {
    output += String(chunk);
  });
  const exited = new Promise<void>(resolve => server.once('exit', () => resolve()));
  const serverAlive = (): void => {
    if (server.exitCode !== null || server.signalCode !== null) throw new Error(output);
  };
  const startedRuns = (): string[] =>
    readdirSync(markers)
      .filter(name => name.endsWith('.started'))
      .map(name => name.slice(0, -'.started'.length));
  const leaked = (runId: string): boolean => existsSync(join(markers, `${runId}.leaked`));
  let passed = false;
  try {
    await waitFor(() => {
      serverAlive();
      return existsSync(join(root, 'server.port'));
    }, 'the server to listen');
    const base = `http://127.0.0.1:${readFileSync(join(root, 'server.port'), 'utf8')}`;
    const startRun = async (source: string): Promise<string> => {
      const before = startedRuns();
      const response = await fetch(`${base}/webhooks/sources/${source}`, {
        method: 'POST',
        body: '{}',
      });
      expect(response.status).toBe(200);
      let runId: string | undefined;
      await waitFor(() => {
        serverAlive();
        runId = startedRuns().find(id => !before.includes(id));
        return runId !== undefined;
      }, `the ${source} run to start its grandchild`);
      return runId as string;
    };
    const cancelledRun = await startRun('first');
    const otherRun = await startRun('second');

    const cancel = await fetch(`${base}/api/workflows/runs/${cancelledRun}/cancel`, {
      method: 'POST',
    });
    expect(cancel.status).toBe(200);

    // Give the cooperative cancel time to end the cancelled run's tree, then release both
    // grandchildren at the same instant. If the cancelled tree survived the kill, it writes
    // its marker within one poll interval of the control's, not after a fixed lifetime the
    // second run's start could consume.
    await Bun.sleep(TREE_KILL_GRACE_MS);
    await writeFile(join(markers, `${cancelledRun}.release`), '');
    await writeFile(join(markers, `${otherRun}.release`), '');

    // Positive control: the release mechanism works and the runner is responsive.
    await waitFor(() => leaked(otherRun), 'the other run to write its marker after release');
    await Bun.sleep(LEAK_ASSERT_GRACE_MS);
    expect(leaked(cancelledRun)).toBe(false);
    passed = true;
  } finally {
    server.kill('SIGKILL');
    await exited;
    // Release every grandchild still polling so it exits before the temp tree is removed.
    // A correctly-cancelled tree is already dead; the release file is inert for it.
    const unreleased = startedRuns().filter(id => !leaked(id));
    for (const id of unreleased) await writeFile(join(markers, `${id}.release`), '');
    // On failure a grandchild may still be alive; a released one writes within one poll
    // interval, so this drains quickly instead of sleeping a fixed lifetime.
    if (!passed && unreleased.length > 0) {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && unreleased.some(id => !leaked(id))) {
        await Bun.sleep(50);
      }
    }
  }
}, 90_000);
