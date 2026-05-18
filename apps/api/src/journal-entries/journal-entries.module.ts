import { Module } from '@nestjs/common';
import { JournalEntriesController } from './journal-entries.controller.js';
import { JournalEntriesService } from './journal-entries.service.js';

@Module({
  controllers: [JournalEntriesController],
  providers: [JournalEntriesService],
  exports: [JournalEntriesService],
})
export class JournalEntriesModule {}
