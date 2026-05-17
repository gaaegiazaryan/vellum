import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DATABASE_TOKEN, type Db } from '../db/database.module.js';
import { idempotencyKeys } from '../db/schema/idempotency.js';

export interface CachedResponse {
  status: number;
  body: unknown;
}

export type ClaimResult =
  | { kind: 'new' }
  | { kind: 'replay'; response: CachedResponse }
  | { kind: 'conflict' }
  | { kind: 'in_flight' };

export interface ClaimArgs {
  key: string;
  method: string;
  path: string;
  hash: string;
  userId: string | null;
  ttlSeconds: number;
}

@Injectable()
export class IdempotencyService {
  constructor(@Inject(DATABASE_TOKEN) private readonly db: Db) {}

  /**
   * Try to insert a fresh idempotency claim. On conflict, look up the
   * existing row and decide replay / conflict / in-flight.
   *
   * The INSERT ... ON CONFLICT DO NOTHING + RETURNING pattern makes the
   * fast path one round-trip; the slow path (conflict) is two.
   */
  async tryClaim(args: ClaimArgs): Promise<ClaimResult> {
    const expiresAt = new Date(Date.now() + args.ttlSeconds * 1000);

    const inserted = await this.db
      .insert(idempotencyKeys)
      .values({
        key: args.key,
        method: args.method,
        path: args.path,
        userId: args.userId,
        requestHash: args.hash,
        expiresAt,
      })
      .onConflictDoNothing({
        target: [idempotencyKeys.key, idempotencyKeys.method, idempotencyKeys.path],
      })
      .returning({ id: idempotencyKeys.id });

    if (inserted.length > 0) {
      return { kind: 'new' };
    }

    const rows = await this.db
      .select({
        requestHash: idempotencyKeys.requestHash,
        responseStatus: idempotencyKeys.responseStatus,
        responseBody: idempotencyKeys.responseBody,
      })
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.key, args.key),
          eq(idempotencyKeys.method, args.method),
          eq(idempotencyKeys.path, args.path),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) {
      // Race we cannot explain: ON CONFLICT did not insert, but the row is
      // gone by the time we read. Treat as a fresh new claim.
      return { kind: 'new' };
    }

    if (row.requestHash !== args.hash) {
      return { kind: 'conflict' };
    }

    if (row.responseStatus !== null && row.responseBody !== null) {
      return { kind: 'replay', response: { status: row.responseStatus, body: row.responseBody } };
    }

    return { kind: 'in_flight' };
  }

  async store(args: {
    key: string;
    method: string;
    path: string;
    status: number;
    body: unknown;
  }): Promise<void> {
    await this.db
      .update(idempotencyKeys)
      .set({ responseStatus: args.status, responseBody: args.body })
      .where(
        and(
          eq(idempotencyKeys.key, args.key),
          eq(idempotencyKeys.method, args.method),
          eq(idempotencyKeys.path, args.path),
        ),
      );
  }
}
