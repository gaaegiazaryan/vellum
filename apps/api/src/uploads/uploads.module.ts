import { Module, type DynamicModule } from '@nestjs/common';
import { UploadsController } from './uploads.controller.js';
import { UploadsService } from './uploads.service.js';
import { FilesystemStorage, OBJECT_STORAGE, type ObjectStorage } from './storage.js';
import type { Env } from '../config/env.js';

@Module({})
export class UploadsModule {
  static forRoot(env: Env): DynamicModule {
    const storage: ObjectStorage = new FilesystemStorage(env.UPLOAD_DIR);
    return {
      module: UploadsModule,
      controllers: [UploadsController],
      providers: [{ provide: OBJECT_STORAGE, useValue: storage }, UploadsService],
      exports: [UploadsService, OBJECT_STORAGE],
    };
  }
}
