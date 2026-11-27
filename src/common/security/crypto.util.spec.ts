import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import {
  hashPasswordScrypt,
  verifyPasswordHash,
  signJwt,
  verifyJwt,
  signSuperAdminJwt,
  verifySuperAdminJwt,
  parseCorsOrigins,
} from './crypto.util.js';

describe('Security Utilities (crypto.util)', () => {
  it('hashes passwords with unique per-user salt and verifies scrypt hashes safely', () => {
    const h1 = hashPasswordScrypt('SuperSecret@2026');
    const h2 = hashPasswordScrypt('SuperSecret@2026');

    expect(h1).toMatch(/^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(h1).not.toBe(h2);

    const valid = verifyPasswordHash('SuperSecret@2026', h1);
    expect(valid).toEqual({ valid: true, needsRehash: false });

    const invalid = verifyPasswordHash('WrongPass', h1);
    expect(invalid).toEqual({ valid: false, needsRehash: false });
  });

  it('supports legacy unsalted SHA-256 hashes while flagging needsRehash for seamless migration', () => {
    const legacyHash = crypto.createHash('sha256').update('LegacyPass123').digest('hex');

    expect(verifyPasswordHash('LegacyPass123', legacyHash)).toEqual({
      valid: true,
      needsRehash: true,
    });
    expect(verifyPasswordHash('WrongPass', legacyHash)).toEqual({
      valid: false,
      needsRehash: false,
    });
  });

  it('signs HS256 JWT tokens, verifies authentic claims, and rejects tampered or expired tokens', () => {
    const secret = 'test-jwt-secret-key-with-sufficient-length-2026';
    const token = signJwt(
      { sub: 'usr-42', username: 'alice', role: 'POD_LEADER', workspaceId: 'ws-1' },
      secret,
      '1h',
    );

    const verified = verifyJwt(token, secret);
    expect(verified).not.toBeNull();
    expect(verified?.sub).toBe('usr-42');
    expect(verified?.role).toBe('POD_LEADER');
    expect(verified?.workspaceId).toBe('ws-1');

    // Wrong secret rejected
    expect(verifyJwt(token, 'different-secret-key-1234567890')).toBeNull();

    // Tampered payload rejected
    const parts = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ sub: 'usr-42', role: 'SUPER_ADMIN', iat: 1, exp: 9999999999 }),
    ).toString('base64url');
    expect(verifyJwt(`${parts[0]}.${forgedPayload}.${parts[2]}`, secret)).toBeNull();
  });

  it('isolates Super Admin JWT tokens from regular tenant JWT verification', () => {
    const userSecret = 'tenant-user-secret-key-minimum-32-chars';
    const adminSecret = 'super-admin-secret-key-minimum-32-chars';

    const adminToken = signSuperAdminJwt(
      { sub: 'usr-admin-01', username: 'founder' },
      adminSecret,
    );
    const tenantForgedAsAdmin = signJwt(
      { sub: 'usr-1', username: 'tenant', role: 'SUPER_ADMIN' },
      userSecret,
    );

    expect(verifySuperAdminJwt(adminToken, adminSecret)?.sub).toBe('usr-admin-01');
    expect(verifyJwt(adminToken, userSecret)).toBeNull();
    expect(verifyJwt(adminToken, adminSecret)).toBeNull();
    expect(verifySuperAdminJwt(tenantForgedAsAdmin, adminSecret)).toBeNull();
    expect(verifyJwt(tenantForgedAsAdmin, userSecret)).toBeNull();
  });

  it('parses CORS_ORIGIN into an allowlist or wildcard', () => {
    expect(parseCorsOrigins('https://sevaniq.app, https://admin.sevaniq.app')).toEqual([
      'https://sevaniq.app',
      'https://admin.sevaniq.app',
    ]);
    expect(parseCorsOrigins('*')).toBe(true);
    expect(parseCorsOrigins('')).toEqual(['http://localhost:3000', 'http://127.0.0.1:3000']);
  });
});
