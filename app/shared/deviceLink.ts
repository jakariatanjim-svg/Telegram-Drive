import { tl } from '@mtcute/core';
import type { TelegramClient } from '@mtcute/core/client.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { deflateSync, inflateSync } from 'fflate';

const { RpcError } = tl;

export const DEVICE_LINK_PREFIX = 'TD1-';
export const DEVICE_LINK_TTL_SECONDS = 15 * 60; // 15 minutes
const CLOCK_SKEW_GRACE_SECONDS = 120;
const PROTOCOL_VERSION = 0x01;
const TAG_LENGTH = 8;
const MAC_DOMAIN = utf8ToBytes('TelegramDrive-DeviceLink-v1:');

export interface DeviceLinkPayload {
  v: 1;
  apiId: number;
  apiHash: string;
  session: string;
  userId: string;
  issuedAt: number; // Unix seconds
  dedicatedSession: boolean;
}

interface CompactWireJson {
  v: 1;
  i: number;
  h: string;
  s: string;
  u: string;
  t: number;
  d: 0 | 1;
}

export type CreateDeviceLinkResult =
  | {
      status: 'ready';
      code: string;
      qrValue: string;
      expiresAt: number; // Unix ms
      dedicatedSession: boolean;
    }
  | {
      status: 'password_required';
    };

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(encoded: string): Uint8Array {
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padLen);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function computeIntegrityTag(version: number, compressed: Uint8Array): Uint8Array {
  const buf = new Uint8Array(MAC_DOMAIN.length + 1 + compressed.length);
  buf.set(MAC_DOMAIN, 0);
  buf[MAC_DOMAIN.length] = version & 0xff;
  buf.set(compressed, MAC_DOMAIN.length + 1);
  return sha256(buf).subarray(0, TAG_LENGTH);
}

function computeStreamMask(tag: Uint8Array, length: number): Uint8Array {
  const mask = new Uint8Array(length);
  let offset = 0;
  let counter = 0;
  while (offset < length) {
    const seed = new Uint8Array(MAC_DOMAIN.length + TAG_LENGTH + 4);
    seed.set(MAC_DOMAIN, 0);
    seed.set(tag, MAC_DOMAIN.length);
    seed[MAC_DOMAIN.length + TAG_LENGTH] = (counter >>> 24) & 0xff;
    seed[MAC_DOMAIN.length + TAG_LENGTH + 1] = (counter >>> 16) & 0xff;
    seed[MAC_DOMAIN.length + TAG_LENGTH + 2] = (counter >>> 8) & 0xff;
    seed[MAC_DOMAIN.length + TAG_LENGTH + 3] = counter & 0xff;
    const block = sha256(seed);
    const take = Math.min(block.length, length - offset);
    mask.set(block.subarray(0, take), offset);
    offset += take;
    counter++;
  }
  return mask;
}

export function packDeviceLinkToken(input: {
  apiId: number;
  apiHash: string;
  session: string;
  userId: string;
  issuedAt?: number;
  dedicatedSession: boolean;
}): { code: string; qrValue: string; expiresAt: number } {
  const issuedAt = input.issuedAt ?? Math.floor(Date.now() / 1000);
  const wire: CompactWireJson = {
    v: 1,
    i: Number(input.apiId),
    h: input.apiHash.trim(),
    s: input.session.trim(),
    u: String(input.userId ?? ''),
    t: issuedAt,
    d: input.dedicatedSession ? 1 : 0,
  };

  const compressed = deflateSync(utf8ToBytes(JSON.stringify(wire)), { level: 9 });
  const tag = computeIntegrityTag(PROTOCOL_VERSION, compressed);
  const mask = computeStreamMask(tag, compressed.length);

  const masked = new Uint8Array(compressed.length);
  for (let i = 0; i < compressed.length; i++) {
    masked[i] = compressed[i] ^ mask[i];
  }

  const envelope = new Uint8Array(1 + TAG_LENGTH + masked.length);
  envelope[0] = PROTOCOL_VERSION;
  envelope.set(tag, 1);
  envelope.set(masked, 1 + TAG_LENGTH);

  const code = `${DEVICE_LINK_PREFIX}${toBase64Url(envelope)}`;
  const qrValue = `tgdrive://link?code=${code}`;
  const expiresAt = (issuedAt + DEVICE_LINK_TTL_SECONDS) * 1000;
  return { code, qrValue, expiresAt };
}

/**
 * Extracts a `TD1-...` token from a raw code, pasted chat text, or `tgdrive://link?code=...` URL.
 */
export function extractDeviceLinkCode(rawInput: string | null | undefined): string | null {
  if (!rawInput) return null;
  const trimmed = rawInput.trim();
  if (!trimmed) return null;

  // 1. Check URL query/hash forms first (e.g. tgdrive://link?code=TD1-...)
  if (/^(tgdrive:|https?:)/i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      const fromParam = parsed.searchParams.get('code') ?? parsed.searchParams.get('link');
      if (fromParam && fromParam.trim().startsWith(DEVICE_LINK_PREFIX)) {
        return fromParam.replace(/\s+/g, '');
      }
      if (parsed.hash) {
        const hashParams = new URLSearchParams(parsed.hash.replace(/^#/, ''));
        const fromHash = hashParams.get('code') ?? hashParams.get('link');
        if (fromHash && fromHash.trim().startsWith(DEVICE_LINK_PREFIX)) {
          return fromHash.replace(/\s+/g, '');
        }
      }
    } catch {
      // Fall through to regex extraction
    }
  }

  // 2. If user pasted a line-wrapped TD1-... code directly, collapse internal whitespace
  const collapsed = trimmed.replace(/\s+/g, '');
  if (collapsed.startsWith(DEVICE_LINK_PREFIX) && /^TD1-[A-Za-z0-9_-]{32,}$/.test(collapsed)) {
    return collapsed;
  }

  // 3. Extract embedded TD1-... token from surrounding text
  const embedded = trimmed.match(/TD1-[A-Za-z0-9_-]{32,}/);
  return embedded ? embedded[0] : null;
}

export function unpackDeviceLinkToken(
  rawInput: string,
  nowMs = Date.now(),
): DeviceLinkPayload {
  const code = extractDeviceLinkCode(rawInput);
  if (!code || !code.startsWith(DEVICE_LINK_PREFIX)) {
    throw new Error('INVALID_LINK_CODE');
  }

  let envelope: Uint8Array;
  try {
    envelope = fromBase64Url(code.slice(DEVICE_LINK_PREFIX.length));
  } catch {
    throw new Error('INVALID_LINK_CODE');
  }

  if (envelope.length <= 1 + TAG_LENGTH + 8) {
    throw new Error('INVALID_LINK_CODE');
  }

  const version = envelope[0];
  if (version !== PROTOCOL_VERSION) {
    throw new Error('UNSUPPORTED_LINK_CODE_VERSION');
  }

  const tag = envelope.subarray(1, 1 + TAG_LENGTH);
  const masked = envelope.subarray(1 + TAG_LENGTH);
  const mask = computeStreamMask(tag, masked.length);
  const compressed = new Uint8Array(masked.length);
  for (let i = 0; i < masked.length; i++) {
    compressed[i] = masked[i] ^ mask[i];
  }

  const expectedTag = computeIntegrityTag(version, compressed);
  let diff = 0;
  for (let i = 0; i < TAG_LENGTH; i++) {
    diff |= tag[i] ^ expectedTag[i];
  }
  if (diff !== 0) {
    throw new Error('INVALID_LINK_CODE');
  }

  let parsed: CompactWireJson;
  try {
    const inflated = inflateSync(compressed);
    parsed = JSON.parse(new TextDecoder().decode(inflated)) as CompactWireJson;
  } catch {
    throw new Error('INVALID_LINK_CODE');
  }

  const apiId = Number(parsed?.i);
  const apiHash = typeof parsed?.h === 'string' ? parsed.h.trim() : '';
  const session = typeof parsed?.s === 'string' ? parsed.s.trim() : '';
  const userId = typeof parsed?.u === 'string' ? parsed.u : '';
  const issuedAt = Number(parsed?.t);

  if (
    parsed?.v !== 1 ||
    !Number.isInteger(apiId) ||
    apiId <= 0 ||
    apiHash.length < 16 ||
    session.length < 20 ||
    !Number.isFinite(issuedAt) ||
    issuedAt <= 0
  ) {
    throw new Error('INVALID_LINK_CODE');
  }

  const nowSec = Math.floor(nowMs / 1000);
  if (nowSec > issuedAt + DEVICE_LINK_TTL_SECONDS + CLOCK_SKEW_GRACE_SECONDS) {
    throw new Error('LINK_CODE_EXPIRED');
  }

  return {
    v: 1,
    apiId,
    apiHash,
    session,
    userId,
    issuedAt,
    dedicatedSession: parsed.d === 1,
  };
}

function isSessionPasswordNeeded(err: unknown): boolean {
  if (RpcError.is(err, 'SESSION_PASSWORD_NEEDED')) return true;
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /SESSION_PASSWORD_NEEDED/i.test(msg);
}

function isInvalidTwoFaPassword(err: unknown): boolean {
  if (RpcError.is(err, 'PASSWORD_HASH_INVALID')) return true;
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /PASSWORD_HASH_INVALID/i.test(msg);
}

async function finalizeAuthorizedGuest(
  guestClient: TelegramClient,
  authorization: tl.auth.TypeAuthorization,
): Promise<string> {
  if (authorization._ === 'auth.authorizationSignUpRequired') {
    throw new Error('ACCOUNT_SIGNUP_REQUIRED');
  }
  if (authorization.user._ === 'user') {
    await guestClient.notifyLoggedIn(authorization.user);
    return String(authorization.user.id);
  }
  const users = await guestClient.call({
    _: 'users.getUsers',
    id: [{ _: 'inputUserSelf' }],
  });
  const self = users[0];
  if (!self || self._ !== 'user') {
    throw new Error('GUEST_AUTH_USER_MISSING');
  }
  await guestClient.notifyLoggedIn(self);
  return String(self.id);
}

/**
 * Mints a self-contained cross-device sign-in token (`TD1-...` + `tgdrive://link?code=...`)
 * from an already-signed-in Telegram Drive device:
 * 1. First attempts to mint a brand-new, independent Telegram session (`guestClient` +
 *    `auth.exportLoginToken` + `primaryClient` `auth.acceptLoginToken`) so both devices
 *    have independent MTProto `auth_key`s and appear as separate sessions in Telegram.
 * 2. If the account uses 2FA Cloud Password, signals `{ status: 'password_required' }`
 *    and completes `guestClient.checkPassword(password)` once supplied.
 * 3. Automatically falls back to `primaryClient.exportSession()` if Telegram rejects
 *    `auth.acceptLoginToken` for custom `my.telegram.org` `api_id`s.
 */
export async function mintDeviceLinkBundle(params: {
  apiId: number;
  apiHash: string;
  userId: string;
  primaryClient: TelegramClient;
  createGuestClient: () => Promise<TelegramClient>;
  password?: string;
}): Promise<CreateDeviceLinkResult> {
  const { apiId, apiHash, primaryClient, createGuestClient } = params;
  const trimmedPassword = params.password?.trim() ?? '';

  let guestClient: TelegramClient | null = null;
  try {
    guestClient = await createGuestClient();

    const finishWith2fa = async (): Promise<CreateDeviceLinkResult> => {
      if (!trimmedPassword) {
        return { status: 'password_required' };
      }
      try {
        const user = await guestClient!.checkPassword(trimmedPassword);
        const session = await guestClient!.exportSession();
        const packed = packDeviceLinkToken({
          apiId,
          apiHash,
          session,
          userId: String(user.id),
          dedicatedSession: true,
        });
        return {
          status: 'ready',
          ...packed,
          dedicatedSession: true,
        };
      } catch (pwErr) {
        if (isInvalidTwoFaPassword(pwErr)) {
          throw new Error('PASSWORD_HASH_INVALID');
        }
        throw pwErr;
      }
    };

    const firstToken = await guestClient.call({
      _: 'auth.exportLoginToken',
      apiId,
      apiHash,
      exceptIds: [],
    });

    if (firstToken._ === 'auth.loginToken') {
      await primaryClient.call({
        _: 'auth.acceptLoginToken',
        token: firstToken.token,
      });

      let secondStep: tl.auth.TypeLoginToken;
      try {
        secondStep = await guestClient.call({
          _: 'auth.exportLoginToken',
          apiId,
          apiHash,
          exceptIds: [],
        });
      } catch (stepErr) {
        if (isSessionPasswordNeeded(stepErr)) {
          return await finishWith2fa();
        }
        throw stepErr;
      }

      if (secondStep._ === 'auth.loginTokenSuccess') {
        const resolvedUid = await finalizeAuthorizedGuest(guestClient, secondStep.authorization);
        const session = await guestClient.exportSession();
        const packed = packDeviceLinkToken({
          apiId,
          apiHash,
          session,
          userId: resolvedUid,
          dedicatedSession: true,
        });
        return {
          status: 'ready',
          ...packed,
          dedicatedSession: true,
        };
      }

      if (secondStep._ === 'auth.loginTokenMigrateTo') {
        await guestClient.changePrimaryDc(secondStep.dcId);
        try {
          const imported = await guestClient.call({
            _: 'auth.importLoginToken',
            token: secondStep.token,
          });
          if (imported._ === 'auth.loginTokenSuccess') {
            const resolvedUid = await finalizeAuthorizedGuest(guestClient, imported.authorization);
            const session = await guestClient.exportSession();
            const packed = packDeviceLinkToken({
              apiId,
              apiHash,
              session,
              userId: resolvedUid,
              dedicatedSession: true,
            });
            return {
              status: 'ready',
              ...packed,
              dedicatedSession: true,
            };
          }
        } catch (migErr) {
          if (isSessionPasswordNeeded(migErr)) {
            return await finishWith2fa();
          }
          throw migErr;
        }
      }
    }
  } catch (err) {
    if (isInvalidTwoFaPassword(err)) {
      throw err;
    }
    // Non-password RPC error (e.g. custom api_id restriction on acceptLoginToken):
    // fall through seamlessly to direct session export below.
  } finally {
    if (guestClient) {
      await guestClient.destroy().catch(() => undefined);
    }
  }

  const fallbackSession = await primaryClient.exportSession();
  const packed = packDeviceLinkToken({
    apiId,
    apiHash,
    session: fallbackSession,
    userId: params.userId,
    dedicatedSession: false,
  });
  return {
    status: 'ready',
    ...packed,
    dedicatedSession: false,
  };
}
