import type { StartRunArgs } from '../primitives/launch';
export type { StartRunArgs } from '../primitives/launch';
import type { paths } from '../../../lib/api.generated';
import { HttpError, requestJson } from '../lib/http';

type WorkflowRunLaunchJson =
  paths['/api/workflows/{name}/run']['post']['requestBody']['content']['application/json'];
type WorkflowRunLaunchMultipart =
  paths['/api/workflows/{name}/run']['post']['requestBody']['content']['multipart/form-data'];
type WorkflowRunBody = Pick<
  WorkflowRunLaunchJson,
  'conversationId' | 'message' | 'inputs' | 'tiers' | 'aliases'
>;

/**
 * Start a run: hides the legacy conversation coupling from the console UI.
 *
 *   1. POST /api/conversations           → { conversationId, id }
 *      `conversationId` is the platform id (`web-<ts>-<rand>`); the dispatch
 *      route looks the conversation up by platform id, not DB UUID.
 *   2. POST /api/workflows/:name/run     → { accepted, status }
 *      Fire-and-forget. The orchestrator creates the workflow_run row
 *      asynchronously after the HTTP response returns, so we deliberately do
 *      not wait for it here — callers should invalidate the runs cache and
 *      let the list polling surface the new run as it appears.
 *
 *      With files attached the dispatch route accepts multipart/form-data,
 *      mirroring /api/conversations/:id/message. Without files we use JSON.
 *
 *   A refused dispatch (4xx) soft-deletes the conversation created in step 1, so a
 *   refused start leaves nothing behind (#159). See `discardConversation`.
 */
export async function startRun({
  projectId,
  workflow,
  message,
  files,
  inputs,
  tiers,
  aliases,
}: StartRunArgs): Promise<void> {
  const conv = await requestJson('/api/conversations', 'post', { body: { codebaseId: projectId } });

  const hasInputs = inputs !== undefined && Object.keys(inputs).length > 0;
  const hasTiers = tiers !== undefined && Object.keys(tiers).length > 0;
  const hasAliases = aliases !== undefined && Object.keys(aliases).length > 0;

  const body = {
    conversationId: conv.conversationId,
    message,
    ...(hasInputs ? { inputs } : {}),
    ...(hasTiers ? { tiers } : {}),
    ...(hasAliases ? { aliases } : {}),
  } satisfies WorkflowRunBody;

  try {
    await requestJson('/api/workflows/{name}/run', 'post', {
      params: { name: workflow },
      body: files !== undefined && files.length > 0 ? buildRunForm(body, files) : body,
    });
  } catch (error: unknown) {
    // Only a 4xx proves the run was never accepted. Every such answer the run route
    // gives — bad body, continuation error, admission refusal, upload refusal — comes
    // before it records the launch message, so the conversation holds no user content
    // and deleting it destroys nothing. A 5xx or a network failure leaves the outcome
    // unknown (a run may well be queued), so the conversation is kept.
    if (error instanceof HttpError && error.status >= 400 && error.status < 500) {
      await discardConversation(conv.conversationId);
    }
    throw error;
  }
}

/**
 * Best-effort cleanup of the conversation a refused start left behind. DELETE is a
 * soft delete (`deleted_at`), which is enough: every reader filters `deleted_at IS
 * NULL`, including the console's list. Failures are swallowed — the refusal is the
 * user-visible answer, and a row that survives is no worse than the bug this fixes.
 */
async function discardConversation(conversationId: string): Promise<void> {
  try {
    await requestJson('/api/conversations/{id}', 'delete', { params: { id: conversationId } });
  } catch {
    // Nothing to report over the refusal that already reached the card.
  }
}

function buildRunForm(body: WorkflowRunBody, files: File[]): FormData {
  // Multipart path: don't set Content-Type — the browser adds the boundary.
  const form = new FormData();
  const fields = {
    conversationId: body.conversationId,
    message: body.message,
    inputs: JSON.stringify(body.inputs),
    tiers: JSON.stringify(body.tiers),
    aliases: JSON.stringify(body.aliases),
  } satisfies { [Key in keyof Required<WorkflowRunBody>]: WorkflowRunLaunchMultipart[Key] };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      form.append(key, value);
    }
  }
  const filesKey = 'files' satisfies keyof WorkflowRunLaunchMultipart;
  for (const file of files) {
    form.append(filesKey, file, file.name);
  }
  return form;
}
