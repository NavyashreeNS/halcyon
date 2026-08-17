import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { EngineError } from '../engine.js';

/**
 * API-key authentication.
 *
 * Keys are compared as SHA-256 digests using a constant-time comparison. Both details
 * matter: storing raw keys means a database leak is immediately a credential leak, and a
 * short-circuiting `===` on secrets leaks their contents through response timing, one byte
 * at a time. Neither is expensive to get right, and both are awkward to retrofit.
 */
export interface TenantIdentity {
  tenantId: string;
  name: string;
}

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

export class TenantDirectory {
  private readonly byKeyHash = new Map<string, TenantIdentity>();

  register(apiKey: string, identity: TenantIdentity): void {
    this.byKeyHash.set(digest(apiKey).toString('hex'), identity);
  }

  resolve(apiKey: string): TenantIdentity | null {
    const candidate = digest(apiKey);
    for (const [hex, identity] of this.byKeyHash) {
      const known = Buffer.from(hex, 'hex');
      if (known.length === candidate.length && timingSafeEqual(known, candidate)) {
        return identity;
      }
    }
    return null;
  }

  get size(): number {
    return this.byKeyHash.size;
  }
}

/**
 * Seeds demo tenants so the stack is usable the moment it boots.
 *
 * These keys are intentionally obvious placeholders. Real deployments supply
 * `TENANT_KEYS` as JSON; the loud names here are so that a key which escapes into a
 * screenshot or a log is unmistakably not a live credential.
 */
export function buildTenantDirectory(env: NodeJS.ProcessEnv = process.env): TenantDirectory {
  const directory = new TenantDirectory();
  const configured = env['TENANT_KEYS'];
  if (configured) {
    const parsed = JSON.parse(configured) as Record<string, TenantIdentity>;
    for (const [key, identity] of Object.entries(parsed)) directory.register(key, identity);
    return directory;
  }
  directory.register('demo-key-premium', { tenantId: 'acme-premium', name: 'Acme (premium)' });
  directory.register('demo-key-free', { tenantId: 'acme-free', name: 'Acme (free tier)' });
  return directory;
}

export function authenticate(directory: TenantDirectory) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<TenantIdentity> => {
    const header = request.headers['x-api-key'];
    const apiKey = Array.isArray(header) ? header[0] : header;
    if (!apiKey) {
      throw new EngineError('unauthorized', 'Missing x-api-key header');
    }
    const identity = directory.resolve(apiKey);
    if (!identity) {
      throw new EngineError('unauthorized', 'Unrecognised API key');
    }
    return identity;
  };
}
