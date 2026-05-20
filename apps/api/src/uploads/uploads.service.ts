import { createHash } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DATABASE_TOKEN, type Db } from '../db/database.module.js';
import { uploads } from '../db/schema/uploads.js';
import { OBJECT_STORAGE, type ObjectStorage } from './storage.js';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

export interface UploadRow {
  id: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: bigint;
  sha256: string;
  createdById: string | null;
  createdAt: Date;
}

@Injectable()
export class UploadsService {
  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: Db,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async create(args: {
    buffer: Buffer;
    mimeType: string;
    userId: string | null;
  }): Promise<UploadRow> {
    if (args.buffer.length === 0) {
      throw new BadRequestException({
        error: 'empty_upload',
        message: 'upload payload is empty',
      });
    }
    if (args.buffer.length > MAX_UPLOAD_BYTES) {
      throw new BadRequestException({
        error: 'upload_too_large',
        message: `upload exceeds ${MAX_UPLOAD_BYTES} bytes`,
        maxBytes: MAX_UPLOAD_BYTES,
      });
    }
    if (!isAllowedMimeType(args.mimeType)) {
      throw new BadRequestException({
        error: 'unsupported_mime_type',
        message: `${args.mimeType} not in allow-list`,
        allowed: ALLOWED_MIME_TYPES,
      });
    }

    const sha256 = createHash('sha256').update(args.buffer).digest('hex');
    const storageKey = await this.storage.put(args.buffer, args.mimeType);

    const [row] = await this.db
      .insert(uploads)
      .values({
        storageKey,
        mimeType: args.mimeType,
        sizeBytes: BigInt(args.buffer.length),
        sha256,
        createdById: args.userId,
      })
      .returning();
    if (!row) throw new Error('failed to insert upload row');
    return row as UploadRow;
  }

  async findById(id: string): Promise<UploadRow | null> {
    const rows = await this.db.select().from(uploads).where(eq(uploads.id, id)).limit(1);
    return (rows[0] as UploadRow | undefined) ?? null;
  }

  async getBytes(id: string): Promise<Buffer> {
    const row = await this.findById(id);
    if (!row) throw new NotFoundException(`upload ${id} not found`);
    return this.storage.get(row.storageKey);
  }
}

function isAllowedMimeType(value: string): value is AllowedMimeType {
  return (ALLOWED_MIME_TYPES as ReadonlyArray<string>).includes(value);
}
