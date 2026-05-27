import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

/**
 * Object storage abstraction. The api stores receipt bytes here so
 * the bytes do not bloat Postgres rows.
 *
 * v1 ships a filesystem implementation. Production deploys swap in an
 * S3-compatible client (Cloudflare R2, Backblaze B2, AWS S3) by
 * binding the OBJECT_STORAGE token to a different concrete instance.
 *
 * Keys are opaque strings the storage layer hands back; callers
 * persist them in the uploads.storage_key column and use them later
 * to fetch the bytes.
 */
export interface ObjectStorage {
  put(buffer: Buffer, mimeType: string): Promise<string>;
  get(key: string): Promise<Buffer>;
}

/**
 * Filesystem-backed storage rooted at a directory the api can write
 * to. The directory comes from the env (UPLOAD_DIR); each put creates
 * a uuid-named file under that root.
 *
 * For production deploys this is the wrong shape: the directory is
 * not shared across replicas, files are not durable across container
 * restarts on platforms with ephemeral filesystems, and a single-node
 * disk runs out faster than object storage scales. Swap to S3 when
 * any of those become a problem.
 */
export class FilesystemStorage implements ObjectStorage {
  constructor(private readonly root: string) {}

  async put(buffer: Buffer, mimeType: string): Promise<string> {
    void mimeType;
    const key = randomUUID();
    const path = join(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, buffer);
    return key;
  }

  async get(key: string): Promise<Buffer> {
    return readFile(join(this.root, key));
  }
}

export interface S3StorageConfig {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Set for S3-compatible providers (R2, B2, MinIO); omit for AWS S3. */
  endpoint?: string;
  /** R2 and MinIO need path-style addressing; AWS S3 wants virtual-host style. */
  forcePathStyle?: boolean;
}

/**
 * S3-compatible storage (ADR-0008). One client covers AWS S3,
 * Cloudflare R2, Backblaze B2, and MinIO; the provider is selected by
 * endpoint and path-style, not by a different class. Keys are the same
 * opaque uuids the filesystem driver mints, so the uploads.storage_key
 * column does not care which driver wrote it.
 */
export class S3Storage implements ObjectStorage {
  private readonly client: S3Client;

  constructor(private readonly config: S3StorageConfig) {
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle ?? false,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async put(buffer: Buffer, mimeType: string): Promise<string> {
    const key = randomUUID();
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
      }),
    );
    return key;
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
    if (!res.Body) throw new Error(`object ${key} has no body`);
    return Buffer.from(await res.Body.transformToByteArray());
  }
}
