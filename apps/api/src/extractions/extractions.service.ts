import { createHash } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { ExtractionError, type ExtractionProvider } from '@vellum/extraction';
import { DATABASE_TOKEN, type Db } from '../db/database.module.js';
import { extractions } from '../db/schema/extractions.js';
import { UploadsService } from '../uploads/uploads.service.js';

export const EXTRACTION_PROVIDER = Symbol('EXTRACTION_PROVIDER');

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
}

@Injectable()
export class ExtractionsService {
  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: Db,
    @Inject(EXTRACTION_PROVIDER) private readonly provider: ExtractionProvider,
    private readonly uploadsService: UploadsService,
  ) {}

  /**
   * Create an extraction for a given upload. Synchronous v1: the
   * handler waits for the provider, persists the result, returns the
   * row. Async via BullMQ worker is the next step when latency or
   * batch cost becomes a real problem.
   *
   * Idempotency by request hash. request_hash = sha256(uploadId +
   * provider.name + provider.model). If a row already exists with
   * this hash, return it instead of re-running the model. This is the
   * cheapest reasonable dedupe; richer prompt + image hash dedupe
   * lives in a follow-up.
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

    if (existing && (existing.status === 'succeeded' || existing.status === 'needs_review')) {
      return rowFromDb(existing);
    }

    const buffer = await this.uploadsService.getBytes(upload.id);
    const imageBase64 = buffer.toString('base64');

    let result;
    try {
      result = await this.provider.extract({
        imageBase64,
        mimeType: upload.mimeType as 'image/png' | 'image/jpeg' | 'image/webp',
      });
    } catch (err) {
      const [failed] = await this.db
        .insert(extractions)
        .values({
          uploadId: upload.id,
          provider: this.provider.name,
          model: this.provider.model,
          promptVersion: 'unknown',
          requestHash,
          status: 'failed',
          errorCode: err instanceof ExtractionError ? err.name : 'unknown_error',
          errorMessage: err instanceof Error ? err.message : String(err),
          createdById: args.userId,
          completedAt: new Date(),
        })
        .returning();
      if (!failed) throw new Error('failed to record extraction failure');
      throw new BadRequestException({
        error: 'extraction_failed',
        code: err instanceof ExtractionError ? err.name : 'unknown_error',
        message: err instanceof Error ? err.message : String(err),
        extractionId: failed.id,
      });
    }

    const status = result.confidence >= CONFIDENCE_REVIEW_THRESHOLD ? 'succeeded' : 'needs_review';

    const [row] = await this.db
      .insert(extractions)
      .values({
        uploadId: upload.id,
        provider: result.provider,
        model: result.model,
        promptVersion: 'unknown',
        requestHash,
        responseHash: result.rawResponseHash ?? null,
        costInputTokens: result.cost.inputTokens,
        costOutputTokens: result.cost.outputTokens,
        costEstimatedUsd: result.cost.estimatedUsd,
        confidence: result.confidence.toFixed(3),
        status,
        receipt: result.receipt,
        createdById: args.userId,
        completedAt: result.extractedAt,
      })
      .returning();
    if (!row) throw new Error('failed to insert extraction row');
    return rowFromDb(row);
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
  };
}

/**
 * Helper used by tests + by service when caller needs to track the
 * confidence cutoff out of band.
 */
export { CONFIDENCE_REVIEW_THRESHOLD };
