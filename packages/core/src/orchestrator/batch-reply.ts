import type { ProviderEvent } from '@archon/provider-contract';

export type ReplyChunk = Pick<
  Extract<ProviderEvent, { type: 'agent_message_chunk' }>,
  'text' | 'continuesPreviousBlock'
>;

export function shiftReplyChunk(chunks: ReplyChunk[]): void {
  const oldest = chunks.shift();
  const next = chunks[0];
  // A retained continuation is incomplete without its opener; merge so dropping the
  // oldest chunk never drops part of a reply block.
  if (oldest && next?.continuesPreviousBlock) {
    chunks[0] = { ...oldest, text: oldest.text + next.text };
  }
}

function replyChunks(chunks: readonly (ReplyChunk | string)[]): ReplyChunk[] {
  return chunks.map(chunk => (typeof chunk === 'string' ? { text: chunk } : chunk));
}

function replyBlocks(chunks: readonly ReplyChunk[]): string[] {
  const assistantMessages: string[] = [];
  for (const chunk of chunks) {
    const previous = assistantMessages.length - 1;
    if (chunk.continuesPreviousBlock && previous >= 0) assistantMessages[previous] += chunk.text;
    else assistantMessages.push(chunk.text);
  }
  return assistantMessages;
}

/**
 * Compose the batched chat reply: merge continuation chunks into blocks, drop blank
 * blocks, and join the rest with a visible separator.
 *
 * Tool-call indicators never appear here: they arrive as `tool_call` provider events,
 * not as `agent_message_chunk` text, so filtering reply text by emoji (the previous
 * behavior) could only ever delete model prose.
 */
export function composeBatchReply(input: readonly (ReplyChunk | string)[]): string {
  const blocks = replyBlocks(replyChunks(input));
  const separator = '\n\n---\n\n';

  // Drop empty blocks before joining so an empty block does not leave a bare
  // `---` separator behind.
  return blocks
    .filter(message => message.trim() !== '')
    .join(separator)
    .trim();
}
