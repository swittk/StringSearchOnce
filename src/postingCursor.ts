import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

type SigningKey = string | Uint8Array;

export function postingCursorDigest(fields: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

function mac(payload: string, key: SigningKey): Buffer {
  return createHmac('sha256', key).update(payload).digest();
}

export function writePostingCursor(
  key: SigningKey, digest: string, tier: number, position: number | string
): string {
  const payload = Buffer.from(JSON.stringify([1, digest, tier, position])).toString('base64url');
  return payload + '.' + mac(payload, key).toString('base64url');
}

export function readPostingCursor(
  token: string, key: SigningKey, digest: string, tierCount: number
): [tier: number, position: unknown] {
  if (token.length > 4096) throw new Error('POSTING_CURSOR_INVALID');
  const fields = token.split('.');
  if (fields.length !== 2) throw new Error('POSTING_CURSOR_INVALID');
  const payload = fields[0]!;
  const provided = Buffer.from(fields[1]!, 'base64url');
  const expected = mac(payload, key);
  if (
    provided.byteLength !== expected.byteLength ||
    !timingSafeEqual(
      new Uint8Array(provided.buffer, provided.byteOffset, provided.byteLength),
      new Uint8Array(expected.buffer, expected.byteOffset, expected.byteLength)
    )
  )
    throw new Error('POSTING_CURSOR_INVALID');
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new Error('POSTING_CURSOR_INVALID');
  }
  if (!Array.isArray(decoded) || decoded.length !== 4)
    throw new Error('POSTING_CURSOR_INVALID');
  const [version, cursorDigest, tier, position] = decoded;
  if (
    version !== 1 || cursorDigest !== digest ||
    !Number.isSafeInteger(tier) || tier < 0 || tier >= tierCount
  )
    throw new Error('POSTING_CURSOR_INVALID');
  return [tier, position];
}
