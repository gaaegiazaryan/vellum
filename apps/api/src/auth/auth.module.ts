import { Module, type DynamicModule } from '@nestjs/common';
import { AUTH_SECRET_TOKEN, AuthGuard } from './auth.guard.js';
import type { Env } from '../config/env.js';

@Module({})
export class AuthModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: AuthModule,
      global: true,
      providers: [{ provide: AUTH_SECRET_TOKEN, useValue: env.AUTH_SECRET }, AuthGuard],
      exports: [AuthGuard, AUTH_SECRET_TOKEN],
    };
  }
}
