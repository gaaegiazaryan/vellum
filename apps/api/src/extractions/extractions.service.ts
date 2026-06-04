import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
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

const CONFIDENCE_REVIEW_THRESHOLD = 0.7;

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

export interface ConfirmExtractionInput {
  debitAccountId: string;
  creditAccountId: string;
  description?: string;
  /**
   * Optional human corrections applied when building the entry. The
   * model misreads totals and dates; the reviewer fixes them here. The
   * stored receipt jsonb is never mutated (ADR-0005 audit integrity) -
   * the correction lives on the journal entry, and the gap between the
   * two is the record of what the human changed.
   */
  totalMinor?: string;
  occurredAt?: Date;
  currency?: string;
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
    await this.budget.assertWithinBudget();

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
    // queued under-budget cannot run after the cap was hit.
    await this.budget.assertWithinBudget();

    const buffer = await this.uploadsService.getBytes(upload.id);
    const result = await this.provider.extract({
      imageBase64: buffer.toString('base64'),
      mimeType: upload.mimeType as 'image/png' | 'image/jpeg' | 'image/webp',
    });

    const status = result.confidence >= CONFIDENCE_REVIEW_THRESHOLD ? 'succeeded' : 'needs_review';
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
   * Turn a confirmed extraction into a ledger entry. The receipt total
   * becomes a single two-line balanced entry: debit the chosen expense
   * account, credit the chosen payment account (ADR-0006). The human
   * picks both accounts; the image cannot.
   *
   * Everything runs in one transaction with the extraction row locked
   * FOR UPDATE, so two concurrent confirms cannot both post an entry.
   * Balance holds by construction (two equal lines, one currency); the
   * per-entry balance trigger is the backstop, so this path does not
   * re-run assertBalanced.
   */
  async confirm(
    extractionId: string,
    input: ConfirmExtractionInput,
    userId: string | null,
  ): Promise<ConfirmExtractionResult> {
    if (input.debitAccountId === input.creditAccountId) {
      throw new BadRequestException({
        error: 'same_account',
        message: 'debit and credit accounts must differ',
      });
    }

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
      const total =
        input.totalMinor !== undefined ? BigInt(input.totalMinor) : BigInt(receipt.totalMinor);
      if (total <= 0n) {
        throw new UnprocessableEntityException({
          error: 'non_positive_total',
          message: 'total must be positive to post a journal entry',
        });
      }
      const occurredAt = input.occurredAt ?? receipt.occurredAt;
      const currency = input.currency ?? receipt.currency;

      const accountIds = [input.debitAccountId, input.creditAccountId];
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

      await tx.insert(ledgerLines).values([
        {
          journalEntryId: entry.id,
          accountId: input.debitAccountId,
          side: 'DEBIT',
          amount: total,
          memo: null,
          position: 0,
        },
        {
          journalEntryId: entry.id,
          accountId: input.creditAccountId,
          side: 'CREDIT',
          amount: total,
          memo: null,
          position: 1,
        },
      ]);

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

/**
 * Helper used by tests + by service when caller needs to track the
 * confidence cutoff out of band.
 */
export { CONFIDENCE_REVIEW_THRESHOLD };
