import { defineConfig } from 'drizzle-kit';

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for drizzle-kit. Set it in your shell or .env.');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/*.ts',
  out: './src/db/migrations',
  dbCredentials: { url: databaseUrl },
  casing: 'snake_case',
  strict: true,
  verbose: true,
});
