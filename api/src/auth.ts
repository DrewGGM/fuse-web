/**
 * Anonymous player tokens.
 *
 * There are no accounts, so this is not really authentication — it is a way to
 * bind submissions to a stable identity so the three-attempt rule can be
 * enforced. An HMAC over `playerId.expiry` is exactly enough for that and adds
 * no dependency and no user data.
 */

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function base64url(bytes: Uint8Array<ArrayBuffer>): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function issueToken(playerId: string, secret: string, now = Date.now()): Promise<string> {
  const payload = `${playerId}.${now + TOKEN_TTL_MS}`;
  const sig = await crypto.subtle.sign('HMAC', await key(secret), new TextEncoder().encode(payload));
  return `${base64url(new TextEncoder().encode(payload) as Uint8Array<ArrayBuffer>)}.${base64url(new Uint8Array(sig))}`;
}

/** Returns the player id, or null for anything that does not verify. Never throws. */
export async function verifyToken(
  token: string,
  secret: string,
  now = Date.now()
): Promise<string | null> {
  if (!token || !token.includes('.')) return null;

  const cut = token.lastIndexOf('.');
  const payloadPart = token.slice(0, cut);
  const sigPart = token.slice(cut + 1);
  if (!payloadPart || !sigPart) return null;

  let payloadBytes: Uint8Array<ArrayBuffer>;
  let sigBytes: Uint8Array<ArrayBuffer>;
  try {
    payloadBytes = fromBase64url(payloadPart);
    sigBytes = fromBase64url(sigPart);
  } catch {
    return null;
  }

  // crypto.subtle.verify is constant time, which is why the comparison is not
  // done by hand here.
  const ok = await crypto.subtle.verify('HMAC', await key(secret), sigBytes, payloadBytes);
  if (!ok) return null;

  const payload = new TextDecoder().decode(payloadBytes);
  const at = payload.lastIndexOf('.');
  if (at < 0) return null;

  const playerId = payload.slice(0, at);
  const expiry = Number(payload.slice(at + 1));
  if (!playerId || !Number.isFinite(expiry) || expiry < now) return null;

  return playerId;
}
