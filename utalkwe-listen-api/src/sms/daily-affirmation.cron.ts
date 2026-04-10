import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CallersService } from '../callers/callers.service';
import { SmsService } from './sms.service';

@Injectable()
export class DailyAffirmationCron {
  private readonly logger = new Logger(DailyAffirmationCron.name);

  constructor(
    private readonly callersService: CallersService,
    private readonly smsService: SmsService,
  ) {}

  // Runs every day at 8:00 AM server time
  @Cron(CronExpression.EVERY_DAY_AT_8AM)
  async sendMorningAffirmations(): Promise<void> {
    this.logger.log('Starting daily affirmation send…');

    try {
      const callers = await this.callersService.findAffirmationOptedIn();

      if (callers.length === 0) {
        this.logger.log('No callers opted in — skipping.');
        return;
      }

      this.logger.log(`Sending affirmations to ${callers.length} caller(s)`);

      let sent = 0;
      let failed = 0;

      for (const caller of callers) {
        try {
          const isFaith = caller.guidance_type === 'faith';
          await this.smsService.sendDailyAffirmation(
            caller.id,
            caller.phone,
            caller.name,
            isFaith,
          );
          sent++;
        } catch (err) {
          failed++;
          this.logger.error(
            `Affirmation failed for ${this.callersService.maskPhone(caller.phone)}`,
            err,
          );
        }
      }

      this.logger.log(`Daily affirmations complete: ${sent} sent, ${failed} failed`);
    } catch (err) {
      this.logger.error('Daily affirmation cron failed', err);
    }
  }
}
