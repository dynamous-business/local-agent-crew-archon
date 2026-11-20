import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * `denied_tools` is a provider tool filter, not a network policy. The security reference must
 * not describe it as one, and must point at the surfaces that do enforce a boundary.
 */
const toolRestrictionsSection = (): string => {
  const page = readFileSync(new URL('./content/docs/reference/security.md', import.meta.url), 'utf8');
  const start = page.indexOf('## Tool Restrictions');
  const end = page.indexOf('## ', start + 1);
  expect(start).toBeGreaterThan(-1);
  return page.slice(start, end === -1 ? undefined : end);
};

test('the tool restriction example does not claim a network boundary', () => {
  const section = toolRestrictionsSection();

  expect(section).not.toMatch(/no internet access/i);
});

test('the tool restriction section says Bash and network reach survive a deny-only node', () => {
  const section = toolRestrictionsSection();

  expect(section).toMatch(/`Bash` stays available/);
  expect(section).toMatch(/curl/);
  expect(section).toContain('/reference/workflow-language/#claude-sdk-advanced-options');
  expect(section).toContain('/guides/container-isolation/');
});
