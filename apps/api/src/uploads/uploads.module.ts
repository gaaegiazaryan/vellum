import { Module, type DynamicModule } from '@nestjs/common';
import { UploadsController } from './uploads.controller.js';
import { UploadsService } from './uploads.service.js';
import { FilesystemStorage, OBJECT_STORAGE, S3Storage, type ObjectStorage } from './storage.js';
import type { Env } from '../config/env.js';

@Module({})
export class UploadsModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: UploadsModule,
      controllers: [UploadsController],
      providers: [{ provide: OBJECT_STORAGE, useValue: pickStorage(env) }, UploadsService],
      exports: [UploadsService, OBJECT_STORAGE],
    };
  }
}

function pickStorage(env: Env): ObjectStorage {
  if (env.STORAGE_DRIVER === 's3') {
    // The env schema already refines that these are set when driver is s3.
    return new S3Storage({
      bucket: env.S3_BUCKET ?? '',
      region: env.S3_REGION ?? '',
      accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
    });
  }
  return new FilesystemStorage(env.UPLOAD_DIR);
}
