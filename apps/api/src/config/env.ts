import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
    LOG_LEVEL: z.enum(LOG_LEVELS).optional(),
    DATABASE_URL: z
      .string()
      .url()
      .refine((u) => u.startsWith('postgres://') || u.startsWith('postgresql://'), {
        message: 'DATABASE_URL must be a postgres:// or postgresql:// connection string',
      }),
    AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
    REDIS_URL: z
      .string()
      .refine((u) => u.startsWith('redis://') || u.startsWith('rediss://'), {
        message: 'REDIS_URL must be a redis:// or rediss:// connection string',
      })
      .default('redis://localhost:6379/0'),
    UPLOAD_DIR: z.string().default('/tmp/vellum-uploads'),
    STORAGE_DRIVER: z.enum(['filesystem', 's3']).default('filesystem'),
    S3_BUCKET: z.string().min(1).optional(),
    S3_REGION: z.string().min(1).optional(),
    S3_ENDPOINT: z.string().url().optional(),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    S3_FORCE_PATH_STYLE: z
      .string()
      .optional()
      .transform((v) => v === 'true'),
    EXTRACTION_PROVIDER: z.enum(['mock', 'anthropic']).default('mock'),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
  })
  .refine((env) => env.EXTRACTION_PROVIDER !== 'anthropic' || Boolean(env.ANTHROPIC_API_KEY), {
    message: 'EXTRACTION_PROVIDER=anthropic requires ANTHROPIC_API_KEY to be set',
    path: ['ANTHROPIC_API_KEY'],
  })
  .refine(
    (env) =>
      env.STORAGE_DRIVER !== 's3' ||
      Boolean(env.S3_BUCKET && env.S3_REGION && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY),
    {
      message:
        'STORAGE_DRIVER=s3 requires S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY',
      path: ['STORAGE_DRIVER'],
    },
  )
  .transform((env) => ({
    ...env,
    LOG_LEVEL: env.LOG_LEVEL ?? (env.NODE_ENV === 'production' ? 'info' : 'debug'),
    isProduction: env.NODE_ENV === 'production',
  }));

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new EnvValidationError(`invalid environment configuration:\n${issues}`);
  }
  return result.data;
}

export class EnvValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvValidationError';
  }
}
