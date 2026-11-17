// Keep a stalled transport from holding a transfer slot forever. This guards
// only the MTProto upload phase: the file handle has not been posted as a
// Telegram message yet, so retrying after abort cannot duplicate a message.
const UPLOAD_IDLE_MS = 150_000;
const FINALIZATION_MS = 180_000;

export async function withUploadLiveness<T>(
  parentSignal: AbortSignal | undefined,
  upload: (signal: AbortSignal, activity: () => boolean) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let rejectTimeout: (error: Error) => void = () => undefined;
  const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject; });
  const onAbort = () => {
    if (settled) return;
    controller.abort();
    rejectTimeout(new Error('CANCELLED'));
  };
  const activity = (): boolean => {
    if (controller.signal.aborted || settled) return false;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      controller.abort();
      rejectTimeout(new Error('UPLOAD_STALLED: No upload progress for 150 seconds. Retrying the transfer.'));
    }, UPLOAD_IDLE_MS);
    return true;
  };
  if (parentSignal?.aborted) controller.abort();
  parentSignal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (controller.signal.aborted) throw new Error('CANCELLED');
    activity();
    return await Promise.race([upload(controller.signal, activity), timeout]);
  } finally {
    settled = true;
    if (timer) clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onAbort);
  }
}

// Posting an uploaded file is different from transferring bytes: Telegram may
// accept the message despite a timeout or a lost acknowledgement. Never auto-
// retry a send with an unknown outcome; it can create duplicate files.
export class UploadFinalizationError extends Error {
  readonly cause?: unknown;

  constructor(cause?: unknown) {
    super('FINALIZATION_UNCONFIRMED: Telegram did not confirm this file. Check the destination folder before retrying to avoid a duplicate.');
    this.name = 'UploadFinalizationError';
    this.cause = cause;
  }
}

export async function withUploadFinalizationDeadline<T>(send: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      send(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new UploadFinalizationError()), FINALIZATION_MS);
      }),
    ]);
  } catch (error) {
    if (error instanceof UploadFinalizationError) throw error;
    // Explicit server rejections are definitive (the file was not posted).
    // Preserve their useful error text instead of labeling them uncertain.
    const message = error instanceof Error ? error.message : String(error);
    if (/FILE_TOO_BIG|FILE_PARTS_INVALID|FILE_INVALID|CHAT_WRITE_FORBIDDEN|USER_BANNED_IN_CHANNEL/i.test(message)) {
      throw error;
    }
    throw new UploadFinalizationError(error);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
