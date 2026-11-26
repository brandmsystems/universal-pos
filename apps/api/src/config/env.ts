function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set`);
  }
  return value;
}

export const env = {
  ownerDatabaseUrl: () => required('DATABASE_URL_OWNER'),
  appDatabaseUrl: () => required('DATABASE_URL_APP'),
  platformReadonlyDatabaseUrl: () => required('DATABASE_URL_PLATFORM_READONLY'),
  redisUrl: () => required('REDIS_URL'),
  /**
   * No default, ever. A signing key with a fallback is a signing key every
   * deployment that forgot to set one shares.
   */
  jwtSigningKey: () => {
    const key = required('JWT_SIGNING_KEY');
    if (key.length < 32) {
      throw new Error('JWT_SIGNING_KEY must be at least 32 characters');
    }
    return key;
  },
  port: (): number => {
    const raw = process.env['PORT'] ?? '8080';
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new Error(`PORT must be a valid port number, got ${raw}`);
    }
    return parsed;
  },
  auditPartitionMonthsAhead: (): number => {
    const raw = process.env['AUDIT_PARTITION_MONTHS_AHEAD'] ?? '3';
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`AUDIT_PARTITION_MONTHS_AHEAD must be a positive integer, got ${raw}`);
    }
    return parsed;
  },
};
