import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { CallersModule } from './callers/callers.module';
import { CoachingModule } from './coaching/coaching.module';
import { SmsModule } from './sms/sms.module';
import { StripeModule } from './stripe/stripe.module';
import { SupabaseModule } from './supabase/supabase.module';
import { VapiModule } from './vapi/vapi.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    SupabaseModule,
    CallersModule,
    CoachingModule,
    SmsModule,
    StripeModule,
    VapiModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
