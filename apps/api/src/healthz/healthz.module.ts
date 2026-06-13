import { Module } from '@nestjs/common';
import { HealthzController } from './healthz.controller.js';
import { ReadyzController } from './readyz.controller.js';

@Module({
  controllers: [HealthzController, ReadyzController],
})
export class HealthzModule {}
