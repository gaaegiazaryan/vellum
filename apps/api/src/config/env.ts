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
    UPLOAD_DIR: z.string().default('/tmp/vellum-uploads'),
    EXTRACTION_PROVIDER: z.enum(['mock', 'anthropic']).default('mock'),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
  })
  .refine((env) => env.EXTRACTION_PROVIDER !== 'anthropic' || Boolean(env.ANTHROPIC_API_KEY), {
    message: 'EXTRACTION_PROVIDER=anthropic requires ANTHROPIC_API_KEY to be set',
    path: ['ANTHROPIC_API_KEY'],
  })
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
