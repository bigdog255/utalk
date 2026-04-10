import { Module } from '@nestjs/common';
import { CallersModule } from '../callers/callers.module';
import { DailyAffirmationCron } from './daily-affirmation.cron';
import { SmsService } from './sms.service';

@Module({
  imports: [CallersModule],
  providers: [SmsService, DailyAffirmationCron],
  exports: [SmsService],
})
export class SmsModule {}
