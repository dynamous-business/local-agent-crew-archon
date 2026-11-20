import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';

const paths = { ...(await import('@archon/paths')) };
const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  ...paths,
  createLogger: mock(() => mockLogger),
}));

const { buildRequestSubprocessEnv } = await import('./provider');

const TOKEN = 'super-secret-token-value';

/** Every field logged by every mockLogger call, flattened. */
function loggedFields(): unknown[] {
  return mockLogger.info.mock.calls
    .concat(mockLogger.debug.mock.calls)
    .flat(1)
    .flatMap(arg => (arg && typeof arg === 'object' ? Object.values(arg) : [arg]));
}

describe('buildRequestSubprocessEnv — auth source log', () => {
  const saved = {
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    CLAUDE_API_KEY: process.env.CLAUDE_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };

  beforeEach(() => {
    mockLogger.info.mockClear();
    mockLogger.debug.mockClear();
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function authSourceFields(): Record<string, unknown> {
    const calls = mockLogger.info.mock.calls.filter(call => call[1] === 'claude.auth_source');
    expect(calls).toHaveLength(1);
    return calls[0][0] as Record<string, unknown>;
  }

  test('delivered per-user credential with no install token logs delivered, not global', () => {
    buildRequestSubprocessEnv({
      env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
      userCredentialEnvKeys: ['CLAUDE_CODE_OAUTH_TOKEN'],
    });

    const fields = authSourceFields();
    expect(fields.authSource).toBe('delivered');
    expect(fields.credential).toBe('CLAUDE_CODE_OAUTH_TOKEN');
    // The regression: this used to log `using_global_auth` here.
    expect(JSON.stringify(mockLogger.info.mock.calls)).not.toContain('using_global_auth');
    expect(loggedFields()).not.toContain(TOKEN);
  });

  test('install-wide explicit token logs install_token', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'install-token';

    buildRequestSubprocessEnv({ env: { FOO: 'bar' } });

    const fields = authSourceFields();
    expect(fields.authSource).toBe('install_token');
    expect(fields.credential).toBeUndefined();
    expect(loggedFields()).not.toContain('install-token');
  });

  test('neither delivered nor install token logs native_login', () => {
    buildRequestSubprocessEnv({ env: { FOO: 'bar' } });

    const fields = authSourceFields();
    expect(fields.authSource).toBe('native_login');
    expect(fields.credential).toBeUndefined();
  });
});
