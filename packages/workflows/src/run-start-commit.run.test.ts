// @archon-test-isolated
/**
 * `$RUN_START_COMMIT` at the run boundary: a `bash:` node that runs AFTER another node
 * has committed still reads the commit the RUN started from — the run row's
 * `checkout_baseline.commit` — not the moved HEAD. The value is the recorded baseline
 * delivered through the executor's scope, never a fresh sample.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { executeWorkflow } from './executor';
import { discoverWorkflows } from './workflow-discovery';
import { providerRegistry } from '@archon/providers';
import { makeDeps, makePlatform } from './child-runs/test-utils';
import { InMemoryStore } from './child-runs/test-store';
import type { WorkflowDeps } from './deps';
import type { ResolvedWorkflow } from './schemas/workflow';

const execFileAsync = promisify(execFile);

let cwd: string;
const originalArchonHome = process.env.ARCHON_HOME;

/** Runs git in the seeded repository with a self-contained identity. */
async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

beforeEach(async () => {
  cwd = join(tmpdir(), `run-start-commit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(cwd, '.archon', 'workflows'), { recursive: true });
  process.env.ARCHON_HOME = join(cwd, 'home');
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.name', 'Archon Test');
  await git('config', 'user.email', 'test@example.invalid');
  await git('config', 'commit.gpgsign', 'false');
  await writeFile(join(cwd, 'README.md'), 'seed\n');
  await git('add', '-A');
  await git('commit', '-qm', 'seed');
});

afterEach(async () => {
  await removeTempTree(cwd);
  if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalArchonHome;
});

async function discover(name: string): Promise<ResolvedWorkflow> {
  const result = await discoverWorkflows(cwd, { providers: providerRegistry, loadDefaults: false });
  const wf = result.workflows.find(w => w.workflow.name === name);
  if (!wf) throw new Error(`workflow ${name} not found: ${JSON.stringify(result.errors)}`);
  return wf.workflow;
}

function nodeOutput(store: InMemoryStore, step: string): string {
  const event = store.events.find(e => e.event_type === 'node_completed' && e.step_name === step);
  return String(event?.data?.node_output).trim();
}

describe('$RUN_START_COMMIT at the run boundary', () => {
  it('is the run baseline for a later node even after an earlier node committed', async () => {
    // The `change` node commits; `later` must still name the pre-run commit through the
    // substituted token AND the subprocess env, while HEAD has moved.
    await writeFile(
      join(cwd, '.archon', 'workflows', 'start-commit.yaml'),
      `
name: start-commit
description: a later node reads the commit the run started from
nodes:
  - id: change
    bash: git commit -q --allow-empty -m "work done by the run"
  - id: later
    depends_on: [change]
    bash: |
      echo "subst=$RUN_START_COMMIT"
      echo "env=\${RUN_START_COMMIT}"
      echo "head=$(git rev-parse HEAD)"
`
    );
    const startCommit = await git('rev-parse', 'HEAD');

    const store = new InMemoryStore();
    const deps: WorkflowDeps = makeDeps(store);
    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('start-commit'),
      'goal',
      { conversationId: 'conv-db' },
      { baseBranch: 'main' }
    );

    if (!result.success) throw new Error(`run failed: ${result.error}`);
    const lines = Object.fromEntries(
      nodeOutput(store, 'later')
        .split('\n')
        .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
    );
    expect(lines.subst).toBe(startCommit);
    expect(lines.env).toBe(startCommit);
    // The commit node ran first and moved HEAD; the run's start commit did not move.
    expect(lines.head).not.toBe(startCommit);

    // The delivered value is the run row's recorded baseline, not a second opinion.
    const run = await store.getWorkflowRun(result.workflowRunId);
    const baseline = run?.checkout_baseline;
    expect(baseline?.kind).toBe('git');
    // The run row is the only source of the delivered value; compare on the narrowed git
    // branch so the commit cannot be compared against an observation of another kind.
    expect(baseline?.kind === 'git' ? baseline.commit : null).toBe(startCommit);
  });
});
