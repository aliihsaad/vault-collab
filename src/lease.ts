const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;

export function getLeaseTtlMs(): number {
  const env = process.env.VAULT_COLLAB_LEASE_TTL_MS;
  if (!env) {
    return DEFAULT_LEASE_TTL_MS;
  }

  const parsed = Number.parseInt(env, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LEASE_TTL_MS;
  }

  return parsed;
}
