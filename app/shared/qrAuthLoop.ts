import { tl, User } from '@mtcute/core';
import type { TelegramClient } from '@mtcute/core/client.js';

const { RpcError } = tl;

export interface RobustQrSignInOptions {
  abortSignal?: AbortSignal;
  /** Poll interval in ms while waiting for mobile scan / server token rotation. Default: 2000ms. */
  pollIntervalMs?: number;
  onUrlUpdated: (url: string, expiresAt: Date) => void;
  onQrScanned?: () => void;
  password: () => Promise<string>;
  invalidPasswordCallback?: () => void | Promise<void>;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (!err) return false;
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return /abort|cancelled|canceled/i.test(msg);
}

function isRecoverableQrTokenError(err: unknown): boolean {
  if (
    RpcError.is(err, 'AUTH_TOKEN_EXPIRED') ||
    RpcError.is(err, 'AUTH_TOKEN_INVALID') ||
    RpcError.is(err, 'AUTH_TOKEN_ALREADY_ACCEPTED')
  ) {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /AUTH_TOKEN_(EXPIRED|INVALID|ALREADY_ACCEPTED)|TIMEOUT|ECONNRESET|ETIMEDOUT|ENETUNREACH|fetch failed|WebSocket/i.test(
    msg,
  );
}

/**
 * Reliable MTProto QR login loop engineered for unauthenticated TCP & WebSocket transports:
 * 1. Keeps the `updateLoginToken` server-update listener registered across ALL token rotations
 *    (unlike `@mtcute/core`'s `signInQr`, which detaches it on the first event).
 * 2. Polls `auth.exportLoginToken` every ~2s alongside server-push wakeups so mobile scans
 *    succeed within 0–2s even when Telegram does not push `updateShort(updateLoginToken)` on
 *    unauthenticated connections or behind NAT/proxies.
 * 3. Emits `onUrlUpdated` only when the login token actually changes, avoiding QR flicker while
 *    staying immune to local PC clock skew against Telegram's `expires` Unix timestamp.
 * 4. Handles `auth.loginTokenMigrateTo` (`changePrimaryDc` + `auth.importLoginToken`),
 *    `SESSION_PASSWORD_NEEDED` 2FA verification (with retry on `PASSWORD_HASH_INVALID`),
 *    and seamless auto-recovery from `AUTH_TOKEN_EXPIRED` / transient socket blips.
 */
export async function runRobustQrSignIn(
  client: TelegramClient,
  options: RobustQrSignInOptions,
): Promise<User> {
  const { abortSignal, onUrlUpdated, onQrScanned } = options;
  const pollIntervalMs = Math.max(800, options.pollIntervalMs ?? 2000);

  let wakeResolver: (() => void) | null = null;
  let pendingPushWake = false;

  const wakeNow = () => {
    if (wakeResolver) {
      const resolve = wakeResolver;
      wakeResolver = null;
      resolve();
    } else {
      pendingPushWake = true;
    }
  };

  const onServerUpdate = (update: tl.TypeUpdates) => {
    if (update._ === 'updateShort' && update.update._ === 'updateLoginToken') {
      onQrScanned?.();
      wakeNow();
    }
  };

  const onAbort = () => {
    wakeNow();
  };

  client.onServerUpdate.add(onServerUpdate);
  abortSignal?.addEventListener('abort', onAbort);

  const waitNextTick = (ms: number): Promise<void> => {
    if (abortSignal?.aborted || client.stopSignal.aborted) {
      return Promise.reject(abortSignal?.reason ?? new Error('QR_LOGIN_ABORTED'));
    }
    if (pendingPushWake) {
      pendingPushWake = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        wakeResolver = null;
        resolve();
      }, ms);
      wakeResolver = () => {
        clearTimeout(timer);
        if (abortSignal?.aborted || client.stopSignal.aborted) {
          reject(abortSignal?.reason ?? new Error('QR_LOGIN_ABORTED'));
          return;
        }
        resolve();
      };
    });
  };

  const complete2fa = async (): Promise<User> => {
    onQrScanned?.();
    while (true) {
      if (abortSignal?.aborted) {
        throw abortSignal.reason ?? new Error('QR_LOGIN_ABORTED');
      }
      const pw = await options.password();
      if (abortSignal?.aborted) {
        throw abortSignal.reason ?? new Error('QR_LOGIN_ABORTED');
      }
      try {
        return await client.checkPassword({
          password: pw,
          abortSignal,
        });
      } catch (err) {
        if (RpcError.is(err, 'PASSWORD_HASH_INVALID')) {
          await options.invalidPasswordCallback?.();
          continue;
        }
        throw err;
      }
    }
  };

  const finalizeAuthorization = async (
    authorization?: tl.auth.TypeAuthorization,
  ): Promise<User> => {
    onQrScanned?.();
    if (authorization && authorization._ === 'auth.authorization') {
      const rawUser = await client.notifyLoggedIn(authorization);
      if (rawUser && rawUser._ === 'user') {
        return new User(rawUser);
      }
    }
    const users = await client.call(
      {
        _: 'users.getUsers',
        id: [{ _: 'inputUserSelf' }],
      },
      { abortSignal },
    );
    const self = users[0];
    if (!self || self._ !== 'user') {
      throw new Error('QR_AUTH_USER_MISSING');
    }
    await client.notifyLoggedIn(self);
    return new User(self);
  };

  let lastEmittedUrl: string | null = null;
  let lastTokenIssuedAt = 0;

  try {
    const { id: apiId, hash: apiHash } = await client.getApiCredentials();

    while (true) {
      if (abortSignal?.aborted || client.stopSignal.aborted) {
        throw abortSignal?.reason ?? new Error('QR_LOGIN_ABORTED');
      }

      let res: tl.auth.TypeLoginToken;
      try {
        res = await client.call(
          {
            _: 'auth.exportLoginToken',
            apiId,
            apiHash,
            exceptIds: [],
          },
          { abortSignal },
        );
      } catch (err) {
        if (isAbortError(err, abortSignal)) {
          throw err;
        }
        if (RpcError.is(err, 'SESSION_PASSWORD_NEEDED')) {
          return await complete2fa();
        }
        if (RpcError.is(err, 'FLOOD_WAIT_%d')) {
          const waitSec = Math.min(15, Math.max(1, err.seconds ?? 2));
          await waitNextTick(waitSec * 1000);
          continue;
        }
        if (isRecoverableQrTokenError(err)) {
          await waitNextTick(1200);
          continue;
        }
        throw err;
      }

      if (res._ === 'auth.loginTokenSuccess') {
        return await finalizeAuthorization(res.authorization);
      }

      if (res._ === 'auth.loginTokenMigrateTo') {
        onQrScanned?.();
        if (abortSignal?.aborted) {
          throw abortSignal.reason ?? new Error('QR_LOGIN_ABORTED');
        }
        await client.changePrimaryDc(res.dcId);
        if (abortSignal?.aborted) {
          throw abortSignal.reason ?? new Error('QR_LOGIN_ABORTED');
        }
        try {
          const imported = await client.call(
            {
              _: 'auth.importLoginToken',
              token: res.token,
            },
            { abortSignal },
          );
          if (imported._ === 'auth.loginTokenSuccess') {
            return await finalizeAuthorization(imported.authorization);
          }
          // If server returned a fresh loginToken after DC switch, continue polling seamlessly.
          lastEmittedUrl = null;
          continue;
        } catch (err) {
          if (isAbortError(err, abortSignal)) {
            throw err;
          }
          if (RpcError.is(err, 'SESSION_PASSWORD_NEEDED')) {
            return await complete2fa();
          }
          if (isRecoverableQrTokenError(err)) {
            lastEmittedUrl = null;
            continue;
          }
          throw err;
        }
      }

      // res._ === 'auth.loginToken'
      const url = `tg://login?token=${encodeBase64Url(res.token)}`;
      const now = Date.now();
      const serverRemainingMs = res.expires * 1000 - now;
      // Guard against PC clock skew: clamp apparent validity window between 5s and 30s
      const effectiveTtlMs =
        Number.isFinite(serverRemainingMs) && serverRemainingMs >= 5_000 && serverRemainingMs <= 60_000
          ? serverRemainingMs
          : 28_000;

      if (url !== lastEmittedUrl) {
        lastEmittedUrl = url;
        lastTokenIssuedAt = now;
        onUrlUpdated(url, new Date(now + effectiveTtlMs));
      } else if (now - lastTokenIssuedAt >= 26_000) {
        // Track monotonic age cleanly even if server re-issues identical token near boundary
        lastTokenIssuedAt = now;
      }

      const sleepMs = Math.min(pollIntervalMs, Math.max(500, effectiveTtlMs - 1500));
      await waitNextTick(sleepMs);
    }
  } finally {
    client.onServerUpdate.remove(onServerUpdate);
    abortSignal?.removeEventListener('abort', onAbort);
  }
}
