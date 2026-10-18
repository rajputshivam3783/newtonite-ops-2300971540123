const isProd = process.env.NODE_ENV === 'production';

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/opsdb',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-only-secret-change-me',
  port: Number(process.env.PORT ?? 3000),
};

if (isProd && config.jwtSecret === 'dev-only-secret-change-me') {
  throw new Error('JWT_SECRET must be set in production');
}
