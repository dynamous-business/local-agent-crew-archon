import type { ChildProcess } from 'node:child_process';
import { closeSync, writeFileSync } from 'node:fs';
import type { Readable } from 'node:stream';

export const DETACHED_RESUME_RECEIPT_ENV = 'ARCHON_DETACHED_RESUME_RECEIPT';
export const DETACHED_RESUME_RECEIPT_FD = 3;
export const DETACHED_RESUME_RECEIPT = 'archon-resume-accepted\n';
export const DETACHED_RESUME_CONFIRMATION_MS = 60_000;
/** Backstop for when a grandchild holds the receipt fd open so the pipe never emits `end`. */
export const DETACHED_RESUME_RECEIPT_DRAIN_MS = 1_000;

export function waitForDetachedResumeReceipt(
  child: ChildProcess,
  pipe: Readable,
  exitError: (code: number | null, signal: NodeJS.Signals | null) => Error
): Promise<void> {
  return new Promise((resolve, reject) => {
    let received = '';
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      clearTimeout(timer);
      if (drainTimer !== undefined) clearTimeout(drainTimer);
      child.off('close', onClose);
      pipe.off('data', onData);
      pipe.off('error', onError);
      pipe.off('end', onEnd);
      pipe.destroy();
      child.unref();
    };
    const settle = (error?: Error): void => {
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error): void => {
      settle(error);
    };
    const onData = (chunk: Buffer | string): void => {
      received += chunk.toString();
      if (received === DETACHED_RESUME_RECEIPT) settle();
      else if (!DETACHED_RESUME_RECEIPT.startsWith(received)) {
        settle(new Error('Malformed detached resume acceptance receipt.'));
      }
    };
    // A Readable delivers every queued `data` event before `end`, so pipe EOF is the
    // safe point to judge exit: a receipt the child wrote before exiting cannot be
    // lost to a `close` that arrives first (Bun on Windows does not order `close`
    // behind stdio drainage). `close` only records the exit details; the drain timer
    // settles anyway if `end` never arrives because a grandchild holds fd 3 open.
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      exited = { code, signal };
      if (pipe.readableEnded) settle(exitError(code, signal));
      else if (drainTimer === undefined) {
        drainTimer = setTimeout(() => {
          if (exited) settle(exitError(exited.code, exited.signal));
        }, DETACHED_RESUME_RECEIPT_DRAIN_MS);
      }
    };
    const onEnd = (): void => {
      if (exited) settle(exitError(exited.code, exited.signal));
    };
    const timer = setTimeout(() => {
      settle(
        new Error(
          'Detached resume acceptance was not confirmed within 60 seconds. The child may still continue; inspect the run before retrying.'
        )
      );
    }, DETACHED_RESUME_CONFIRMATION_MS);
    child.once('close', onClose);
    pipe.on('data', onData);
    pipe.once('error', onError);
    pipe.once('end', onEnd);
  });
}

export function consumeDetachedResumeReceiptRequest(
  onError: (runId: string, error: unknown) => void
): ((runId: string) => void) | undefined {
  const requested = process.env[DETACHED_RESUME_RECEIPT_ENV] === '1';
  Reflect.deleteProperty(process.env, DETACHED_RESUME_RECEIPT_ENV);
  if (!requested) return undefined;
  let sent = false;
  return runId => {
    if (sent) return;
    sent = true;
    try {
      writeFileSync(DETACHED_RESUME_RECEIPT_FD, DETACHED_RESUME_RECEIPT);
    } catch (error) {
      // Admission already committed: losing the launcher must not stop execution.
      onError(runId, error);
    } finally {
      try {
        closeSync(DETACHED_RESUME_RECEIPT_FD);
      } catch (error) {
        onError(runId, error);
      }
    }
  };
}
