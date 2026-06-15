import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { Queue } from 'bullmq';
import {
  ExtractionError,
  ProviderTimeoutError,
  receiptSchema,
  type ExtractionProvider,
} from '@vellum/extraction';
import { DATABASE_TOKEN, type Db } from '../db/database.module.js';
import { extractions } from '../db/schema/extractions.js';
import { accounts, journalEntries, ledgerLines } from '../db/schema/ledger.js';
import { BudgetService } from '../budget/budget.service.js';
import { EXTRACTION_QUEUE, type ExtractionJobData } from '../queue/queue.module.js';
import { UploadsService } from '../uploads/uploads.service.js';
import { ExtractionEventsService } from '../websocket/extraction-events.service.js';

export const EXTRACTION_PROVIDER = Symbol('EXTRACTION_PROVIDER');

/**
 * Whether a failed extraction is worth retrying. Deterministic
 * failures (the model could not read the image, returned junk, or the
 * budget is blown) fail identically on retry and each attempt costs
 * money, so they are not retried. Timeouts and unclassified errors get
 * a bounded retry.
 */
export function isRetryableExtractionError(err: unknown): boolean {
  if (err instanceof ProviderTimeoutError) return true;
  if (err instanceof ExtractionError) return false;
  return true;
}

export const CONFIDENCE_REVIEW_THRESHOLD_TOKEN = Symbol('CONFIDENCE_REVIEW_THRESHOLD');
export const DEFAULT_CONFIDENCE_REVIEW_THRESHOLD = 0.7;

export interface ExtractionRow {
  id: string;
  uploadId: string;
  provider: string;
  model: string;
  promptVersion: string;
  requestHash: string;
  responseHash: string | null;
  costInputTokens: number;
  costOutputTokens: number;
  costEstimatedUsd: string;
  confidence: string | null;
  status: 'pending' | 'succeeded' | 'failed' | 'needs_review';
  receipt: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  createdById: string | null;
  createdAt: Date;
  completedAt: Date | null;
  journalEntryId: string | null;
  confirmedById: string | null;
  confirmedAt: Date | null;
}

export interface ConfirmLine {
  side: 'DEBIT' | 'CREDIT';
  accountId: string;
  amountMinor: string;
  memo?: string;
}

export interface ConfirmExtractionInput {
  /**
   * The simple shape (one debit + one credit). When both these are
   * present and `lines` is absent, the service expands them into a
   * two-line entry exactly like ADR-0006 (the sugar form).
   */
  debitAccountId?: string;
  creditAccountId?: string;
  totalMinor?: string;
  /**
   * The multi-line shape (ADR-0017). When present, takes precedence
   * over the sugar fields. Must contain at least one debit and one
   * credit; sum-of-debits must equal sum-of-credits.
   */
  lines?: ConfirmLine[];
  description?: string;
  /**
   * Optional human corrections applied when building the entry. The
   * model misreads totals and dates; the reviewer fixes them here. The
   * stored receipt jsonb is never mutated (ADR-0005 audit integrity) -
   * the correction lives on the journal entry, and the gap between the
   * two is the record of what the human changed.
   */
  occurredAt?: Date;
  currency?: string;
}

export interface FallbackStats {
  total: number;
  fellBack: number;
  byReason: Record<string, number>;
  byPrimary: Record<string, number>;
  since: string;
  until: string;
}

export interface ConfirmExtractionResult {
  extraction: ExtractionRow;
  journalEntry: {
    id: string;
    occurredAt: Date;
    description: string;
    currency: string;
  };
}

@Injectable()
export class ExtractionsService {
  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: Db,
    @Inject(EXTRACTION_PROVIDER) private readonly provider: ExtractionProvider,
    @Inject(EXTRACTION_QUEUE) private readonly queue: Queue,
    @Inject(CONFIDENCE_REVIEW_THRESHOLD_TOKEN) private readonly reviewThreshold: number,
    private readonly uploadsService: UploadsService,
    private readonly budget: BudgetService,
    private readonly events: ExtractionEventsService,
  ) {}

  /**
   * Accept an extraction request: insert a pending row and enqueue a
   * job, then return immediately (ADR-0007). The vision call runs in
   * the worker, not here.
   *
   * Dedupe by request hash = sha256(uploadId + provider.name +
   * provider.model). A non-failed row for the same hash (pending or
   * terminal) is returned as-is rather than enqueuing a duplicate; a
   * previously failed row is allowed to be retried with a fresh job.
   * The job id is the row id, so the queue itself rejects duplicates.
   */
  async create(args: { uploadId: string; userId: string | null }): Promise<ExtractionRow> {
    const upload = await this.uploadsService.findById(args.uploadId);
    if (!upload) {
      throw new NotFoundException(`upload ${args.uploadId} not found`);
    }

    const requestHash = createHash('sha256')
      .update(`${args.uploadId}\n${this.provider.name}\n${this.provider.model}`)
      .digest('hex');

    const [existing] = await this.db
      .select()
      .from(extractions)
      .where(and(eq(extractions.uploadId, args.uploadId), eq(extractions.requestHash, requestHash)))
      .orderBy(desc(extractions.createdAt))
      .limit(1);

    if (existing && existing.status !== 'failed') {
      return rowFromDb(existing);
    }

    // Cheap, client-facing check. The worker re-checks before each
    // provider call so a long queue cannot quietly slip past the cap.
    // The predicted cost closes the in-flight race: a cap with a few
    // cents of headroom would otherwise admit several jobs that each
    // tip it over.
    await this.budget.assertWithinBudget(args.userId, this.provider.predictedMaxCostUsd());

    const [row] = await this.db
      .insert(extractions)
      .values({
        uploadId: upload.id,
        provider: this.provider.name,
        model: this.provider.model,
        promptVersion: 'unknown',
        requestHash,
        status: 'pending',
        createdById: args.userId,
      })
      .returning();
    if (!row) throw new Error('failed to insert pending extraction row');

    await this.queue.add('extract', { extractionId: row.id } satisfies ExtractionJobData, {
      jobId: row.id,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: true,
      removeOnFail: false,
    });

    return rowFromDb(row);
  }

  /**
   * Run the provider for a pending extraction and persist the result.
   * Called by the worker. Idempotent: a row that already left pending
   * is a no-op (a retry that lands after a prior success). Throws on
   * provider failure so the worker can apply the retry policy; the
   * worker calls recordFailure when it gives up.
   */
  async runExtraction(extractionId: string): Promise<void> {
    const [row] = await this.db
      .select()
      .from(extractions)
      .where(eq(extractions.id, extractionId))
      .limit(1);
    if (!row) throw new Error(`extraction ${extractionId} not found`);
    if (row.status !== 'pending') return;

    const upload = await this.uploadsService.findById(row.uploadId);
    if (!upload) throw new Error(`upload ${row.uploadId} for extraction ${extractionId} not found`);

    // Re-check the daily cap right before the provider call so a job
    // queued under-budget cannot run after the cap was hit. The row
    // remembers who enqueued it so per-user scope still applies in
    // the worker (created_by_id is nullable for legacy rows).
    //
    // Predicted cost matches the enqueue check (ADR-0011 limit #2,
    // ADR-0015 fallback). With the router, predictedMaxCostUsd sums
    // primary plus secondary so a job that fits at re-check time
    // cannot still tip the cap when both providers run.
    await this.budget.assertWithinBudget(
      row.createdById ?? undefined,
      this.provider.predictedMaxCostUsd(),
    );

    const buffer = await this.uploadsService.getBytes(upload.id);
    const result = await this.provider.extract({
      imageBase64: buffer.toString('base64'),
      mimeType: upload.mimeType as 'image/png' | 'image/jpeg' | 'image/webp',
    });

    const status = result.confidence >= this.reviewThreshold ? 'succeeded' : 'needs_review';
    // The router may return a RoutedExtractionResult with the fallback
    // pair populated; downcast through the structural shape so the
    // service does not need to import the router type just to read two
    // optional fields.
    const routed = result as typeof result & {
      fallbackFromProvider?: string | null;
      fallbackReason?: string | null;
    };
    await this.db
      .update(extractions)
      .set({
        provider: result.provider,
        model: result.model,
        responseHash: result.rawResponseHash ?? null,
        costInputTokens: result.cost.inputTokens,
        costOutputTokens: result.cost.outputTokens,
        costEstimatedUsd: result.cost.estimatedUsd,
        confidence: result.confidence.toFixed(3),
        status,
        receipt: result.receipt,
        completedAt: result.extractedAt,
        fallbackFromProvider: routed.fallbackFromProvider ?? null,
        fallbackReason: routed.fallbackReason ?? null,
      })
      .where(eq(extractions.id, extractionId));
    await this.events
      .publish({ extractionId, status, at: new Date().toISOString() })
      .catch(() => {});
  }

  /**
   * Mark an extraction failed. Called by the worker when it gives up
   * (non-retryable error, or attempts exhausted). The error code comes
   * from the ExtractionError taxonomy when available so the audit trail
   * shows what the model did.
   */
  async recordFailure(extractionId: string, err: unknown): Promise<void> {
    await this.db
      .update(extractions)
      .set({
        status: 'failed',
        errorCode: err instanceof ExtractionError ? err.name : 'unknown_error',
        errorMessage: err instanceof Error ? err.message : String(err),
        completedAt: new Date(),
      })
      .where(eq(extractions.id, extractionId));
    await this.events
      .publish({ extractionId, status: 'failed', at: new Date().toISOString() })
      .catch(() => {});
  }

  async findById(id: string): Promise<ExtractionRow | null> {
    const rows = await this.db.select().from(extractions).where(eq(extractions.id, id)).limit(1);
    return rows[0] ? rowFromDb(rows[0]) : null;
  }

  async listForUpload(uploadId: string): Promise<ExtractionRow[]> {
    const rows = await this.db
      .select()
      .from(extractions)
      .where(eq(extractions.uploadId, uploadId))
      .orderBy(desc(extractions.createdAt));
    return rows.map(rowFromDb);
  }

  /**
   * Operator-facing summary of how often the router fell back over
   * a time window. Reads only the audit columns added in ADR-0015
   * (fallback_from_provider, fallback_reason); a confirmed row that
   * did not need a fallback simply contributes to `total`.
   *
   * The reason and primary-name maps surface what was failing so the
   * operator can decide whether to flip EXTRACTION_PROVIDER manually
   * (the ADR-0015 known limit #3 workaround) without having to grep
   * the application log.
   */
  async fallbackStats(since: Date, until: Date): Promise<FallbackStats> {
    const rows = await this.db
      .select({
        total: sql<string>`count(*)::text`,
        fellBack: sql<string>`count(*) filter (where ${extractions.fallbackFromProvider} is not null)::text`,
      })
      .from(extractions)
      .where(and(gte(extractions.createdAt, since), lt(extractions.createdAt, until)));
    const reasonRows = await this.db
      .select({
        reason: extractions.fallbackReason,
        primary: extractions.fallbackFromProvider,
        n: sql<string>`count(*)::text`,
      })
      .from(extractions)
      .where(
        and(
          gte(extractions.createdAt, since),
          lt(extractions.createdAt, until),
          sql`${extractions.fallbackFromProvider} is not null`,
        ),
      )
      .groupBy(extractions.fallbackReason, extractions.fallbackFromProvider);

    const byReason: Record<string, number> = {};
    const byPrimary: Record<string, number> = {};
    for (const r of reasonRows) {
      if (r.reason) byReason[r.reason] = (byReason[r.reason] ?? 0) + Number(r.n);
      if (r.primary) byPrimary[r.primary] = (byPrimary[r.primary] ?? 0) + Number(r.n);
    }
    const first = rows[0];
    return {
      total: Number(first?.total ?? 0),
      fellBack: Number(first?.fellBack ?? 0),
      byReason,
      byPrimary,
      since: since.toISOString(),
      until: until.toISOString(),
    };
  }

  /**
   * Turn a confirmed extraction into a ledger entry. ADR-0006 shipped
   * the two-line shape (one debit + one credit, both for the receipt's
   * total). ADR-0017 extends this to N >= 2 lines per entry so a
   * receipt with separately-stated tax can post the breakdown.
   *
   * The wire body accepts either the sugar form (debitAccountId +
   * creditAccountId) or a lines: [...] array. expandToLines converts
   * sugar to the array shape; everything past that point operates on
   * the array. Balance and account-existence are validated once,
   * regardless of which body shape arrived.
   *
   * Everything runs in one transaction with the extraction row locked
   * FOR UPDATE, so two concurrent confirms cannot both post an entry.
   * The per-entry deferred-trigger balance invariant is the backstop
   * for the application-level check, not a substitute for it.
   */
  async confirm(
    extractionId: string,
    input: ConfirmExtractionInput,
    userId: string | null,
  ): Promise<ConfirmExtractionResult> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(extractions)
        .where(eq(extractions.id, extractionId))
        .for('update')
        .limit(1);
      if (!row) throw new NotFoundException(`extraction ${extractionId} not found`);

      if (row.journalEntryId) {
        throw new ConflictException({
          error: 'already_confirmed',
          message: `extraction ${extractionId} is already linked to a journal entry`,
          journalEntryId: row.journalEntryId,
        });
      }
      if (row.status !== 'succeeded' && row.status !== 'needs_review') {
        throw new UnprocessableEntityException({
          error: 'not_confirmable',
          message: `status ${row.status} cannot be confirmed; only succeeded or needs_review can`,
        });
      }
      if (!row.receipt) {
        throw new UnprocessableEntityException({
          error: 'no_receipt',
          message: 'extraction has no parsed receipt to confirm',
        });
      }

      const receipt = receiptSchema.parse(row.receipt);

      // One of two body shapes lands here. expandToLines is the single
      // place that knows about the two shapes; the rest of confirm
      // talks to a canonical list.
      const lines = expandToLines(input, receipt);

      // Application-level balance check (the deferred trigger is the
      // backstop but a clean 400 with `error: 'unbalanced_entry'` is
      // a better operator experience than a constraint violation).
      const debitSum = lines.filter((l) => l.side === 'DEBIT').reduce((s, l) => s + l.amount, 0n);
      const creditSum = lines.filter((l) => l.side === 'CREDIT').reduce((s, l) => s + l.amount, 0n);
      if (debitSum === 0n || creditSum === 0n) {
        throw new UnprocessableEntityException({
          error: 'non_positive_total',
          message: 'each side must sum to a positive amount',
        });
      }
      if (debitSum !== creditSum) {
        throw new BadRequestException({
          error: 'unbalanced_entry',
          message: 'sum of debit amounts must equal sum of credit amounts',
          debitMinor: debitSum.toString(),
          creditMinor: creditSum.toString(),
        });
      }
      if (lines.some((l) => l.amount <= 0n)) {
        throw new BadRequestException({
          error: 'non_positive_line',
          message: 'every line amount must be positive',
        });
      }

      const occurredAt = input.occurredAt ?? receipt.occurredAt;
      const currency = input.currency ?? receipt.currency;

      const accountIds = Array.from(new Set(lines.map((l) => l.accountId)));
      const found = await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(inArray(accounts.id, accountIds));
      if (found.length !== accountIds.length) {
        const missing = accountIds.filter((id) => !found.some((f) => f.id === id));
        throw new NotFoundException({
          error: 'account_not_found',
          message: 'one or more accountId fields point at accounts that do not exist',
          missing,
        });
      }

      const description = input.description?.trim() || receipt.vendor.name;

      const [entry] = await tx
        .insert(journalEntries)
        .values({
          occurredAt,
          description,
          currency,
          createdById: userId,
        })
        .returning();
      if (!entry) throw new Error('failed to insert journal_entries row');

      await tx.insert(ledgerLines).values(
        lines.map((line, i) => ({
          journalEntryId: entry.id,
          accountId: line.accountId,
          side: line.side,
          amount: line.amount,
          memo: line.memo,
          position: i,
        })),
      );

      const [updated] = await tx
        .update(extractions)
        .set({ journalEntryId: entry.id, confirmedById: userId, confirmedAt: new Date() })
        .where(eq(extractions.id, extractionId))
        .returning();
      if (!updated) throw new Error('failed to link extraction to journal entry');

      return {
        extraction: rowFromDb(updated),
        journalEntry: {
          id: entry.id,
          occurredAt: entry.occurredAt,
          description: entry.description,
          currency: entry.currency,
        },
      };
    });
  }
}

function rowFromDb(r: typeof extractions.$inferSelect): ExtractionRow {
  return {
    id: r.id,
    uploadId: r.uploadId,
    provider: r.provider,
    model: r.model,
    promptVersion: r.promptVersion,
    requestHash: r.requestHash,
    responseHash: r.responseHash,
    costInputTokens: r.costInputTokens,
    costOutputTokens: r.costOutputTokens,
    costEstimatedUsd: r.costEstimatedUsd,
    confidence: r.confidence,
    status: r.status,
    receipt: r.receipt,
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
    createdById: r.createdById,
    createdAt: r.createdAt,
    completedAt: r.completedAt,
    journalEntryId: r.journalEntryId,
    confirmedById: r.confirmedById,
    confirmedAt: r.confirmedAt,
  };
}

interface CanonicalLine {
  side: 'DEBIT' | 'CREDIT';
  accountId: string;
  amount: bigint;
  memo: string | null;
}

/**
 * Expand either confirm body shape into the canonical N-line form
 * (ADR-0017). The sugar form (debitAccountId + creditAccountId +
 * optional totalMinor) becomes two lines for the receipt total; the
 * lines form is parsed straight through, with explicit amounts cast
 * to BigInt. Each path normalizes the same outputs so the caller has
 * one shape to validate.
 */
function expandToLines(
  input: ConfirmExtractionInput,
  receipt: { totalMinor: string },
): CanonicalLine[] {
  if (input.lines !== undefined) {
    if (input.debitAccountId !== undefined || input.creditAccountId !== undefined) {
      throw new BadRequestException({
        error: 'mixed_body_shape',
        message:
          'pass either the lines array or the (debitAccountId, creditAccountId) pair, not both',
      });
    }
    return input.lines.map((l) => ({
      side: l.side,
      accountId: l.accountId,
      amount: BigInt(l.amountMinor),
      memo: l.memo?.trim() ? l.memo.trim() : null,
    }));
  }
  if (input.debitAccountId === undefined || input.creditAccountId === undefined) {
    throw new BadRequestException({
      error: 'missing_accounts',
      message: 'confirm requires either lines or both debitAccountId and creditAccountId',
    });
  }
  if (input.debitAccountId === input.creditAccountId) {
    throw new BadRequestException({
      error: 'same_account',
      message: 'debit and credit accounts must differ',
    });
  }
  const total =
    input.totalMinor !== undefined ? BigInt(input.totalMinor) : BigInt(receipt.totalMinor);
  return [
    { side: 'DEBIT', accountId: input.debitAccountId, amount: total, memo: null },
    { side: 'CREDIT', accountId: input.creditAccountId, amount: total, memo: null },
  ];
}

/**
 * Backward-compatible re-export. Production threads the threshold
 * through DI; this constant is the unconfigured default and is the
 * one callers should reach for when they need a sentinel value.
 */
export const CONFIDENCE_REVIEW_THRESHOLD = DEFAULT_CONFIDENCE_REVIEW_THRESHOLD;
