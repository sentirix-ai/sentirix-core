import * as crypto from 'crypto';

const DEFAULT_DEV_JWT_SECRET = 'sevaniq-local-dev-only-fallback-secret-do-not-use-in-prod';

export interface JwtPayloadInput {
  sub: string;
  username?: string;
  role: string;
  workspaceId?: string;
}

export interface VerifiedJwtPayload extends JwtPayloadInput {
  iat: number;
  exp: number;
}

/**
 * Hash a password using per-user random salt and Node's native scrypt KDF.
 */
export function hashPasswordScrypt(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${derivedKey}`;
}

/**
 * Verify a plaintext password against either modern `scrypt:<salt>:<hash>`
 * or legacy unsalted 64-char SHA-256 hex (signaling when rehash is needed).
 */
export function verifyPasswordHash(
  password: string,
  storedHash: string,
): { valid: boolean; needsRehash: boolean } {
  if (!storedHash) {
    return { valid: false, needsRehash: false };
  }

  if (storedHash.startsWith('scrypt:')) {
    const parts = storedHash.split(':');
    if (parts.length !== 3) {
      return { valid: false, needsRehash: false };
    }
    const [, salt, keyHex] = parts;
    try {
      const derived = crypto.scryptSync(password, salt, 64);
      const expected = Buffer.from(keyHex, 'hex');
      if (derived.length !== expected.length) {
        return { valid: false, needsRehash: false };
      }
      return {
        valid: crypto.timingSafeEqual(derived, expected),
        needsRehash: false,
      };
    } catch {
      return { valid: false, needsRehash: false };
    }
  }

  // Legacy unsalted SHA-256 fallback for pre-existing database accounts
  const legacyHashHex = crypto.createHash('sha256').update(password).digest('hex');
  try {
    const a = Buffer.from(legacyHashHex, 'utf8');
    const b = Buffer.from(storedHash, 'utf8');
    if (a.length !== b.length) {
      return { valid: false, needsRehash: false };
    }
    const matched = crypto.timingSafeEqual(a, b);
    return { valid: matched, needsRehash: matched };
  } catch {
    return { valid: false, needsRehash: false };
  }
}

export function getJwtSecret(): string {
  const configured = process.env.JWT_SECRET?.trim();
  if (configured && configured.length >= 16) {
    return configured;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be configured (min 16 chars) in production.');
  }
  return DEFAULT_DEV_JWT_SECRET;
}

export function parseJwtExpirationSeconds(raw?: string): number {
  const val = (raw || process.env.JWT_EXPIRATION || '7d').trim();
  const match = val.match(/^(\d+)([smhd])?$/i);
  if (!match) return 7 * 24 * 60 * 60;
  const amount = Number(match[1]);
  const unit = (match[2] || 's').toLowerCase();
  const multiplier =
    unit === 'd' ? 86400 : unit === 'h' ? 3600 : unit === 'm' ? 60 : 1;
  return Math.max(60, amount * multiplier);
}

function toBase64Url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function fromBase64Url(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + '='.repeat(padLen), 'base64').toString('utf8');
}

/**
 * Sign a standard HS256 JWT token using HMAC-SHA256.
 */
export function signJwt(
  payload: JwtPayloadInput,
  secret: string = getJwtSecret(),
  expiresIn?: string,
): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const ttlSec = parseJwtExpirationSeconds(expiresIn);
  const fullPayload: VerifiedJwtPayload = {
    ...payload,
    iat: nowSec,
    exp: nowSec + ttlSec,
  };

  const headerPart = toBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payloadPart = toBase64Url(JSON.stringify(fullPayload));
  const signingInput = `${headerPart}.${payloadPart}`;
  const signature = toBase64Url(
    crypto.createHmac('sha256', secret).update(signingInput).digest(),
  );
  return `${signingInput}.${signature}`;
}

/**
 * Verify an HS256 JWT token signature and expiration timestamp.
 */
export function verifyJwt(
  token: string,
  secret: string = getJwtSecret(),
): VerifiedJwtPayload | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerPart, payloadPart, signaturePart] = parts;
  const signingInput = `${headerPart}.${payloadPart}`;
  const expectedSig = toBase64Url(
    crypto.createHmac('sha256', secret).update(signingInput).digest(),
  );

  try {
    const a = Buffer.from(signaturePart, 'utf8');
    const b = Buffer.from(expectedSig, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return null;
    }

    const header = JSON.parse(fromBase64Url(headerPart)) as { alg?: string; typ?: string };
    if (header.alg !== 'HS256') return null;

    const payload = JSON.parse(fromBase64Url(payloadPart)) as VerifiedJwtPayload;
    const nowSec = Math.floor(Date.now() / 1000);
    if (!payload.sub || typeof payload.exp !== 'number' || payload.exp <= nowSec) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * Parse comma-separated CORS_ORIGIN environment setting into an origin whitelist.
 */
export function parseCorsOrigins(raw?: string): string[] | true {
  const value = (raw ?? process.env.CORS_ORIGIN ?? '').trim();
  if (value === '*') return true;
  if (!value) {
    return ['http://localhost:3000', 'http://127.0.0.1:3000'];
  }
  const origins = value
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  return origins.length > 0 ? origins : ['http://localhost:3000', 'http://127.0.0.1:3000'];
}
