Sms.service · TS
Copy

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient } from '@supabase/supabase-js';
import Twilio from 'twilio';
import { SUPABASE_CLIENT } from '../supabase/supabase.module';
import type { SmsMessageType } from './sms.types';
 
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private readonly client: ReturnType<typeof Twilio>;
  private readonly fromNumber: string;
  private readonly linkPerMinute: string;
  private readonly linkUnlimited: string;
 
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly config: ConfigService,
  ) {
    this.client = Twilio(
      config.getOrThrow<string>('TWILIO_ACCOUNT_SID'),
      config.getOrThrow<string>('TWILIO_AUTH_TOKEN'),
    );
    this.fromNumber = config.getOrThrow<string>('TWILIO_PHONE_NUMBER');
    this.linkPerMinute = config.get<string>('STRIPE_PAYMENT_LINK_PER_MINUTE') ?? '';
    this.linkUnlimited = config.get<string>('STRIPE_PAYMENT_LINK_UNLIMITED') ?? '';
  }
 
  // ─── TCPA-gated send ─────────────────────────────────────────────────────────
 
  /**
   * Send an SMS to a caller.
   * By default, requires consent signal (request_coaching_plan called in a session).
   * Pass bypassConsent=true for crisis SMS and service communications.
   */
  async send(
    callerId: string,
    phone: string,
    body: string,
    messageType: SmsMessageType,
    bypassConsent = false,
  ): Promise<void> {
    if (!bypassConsent) {
      const hasConsent = await this.hasConsentSignal(callerId);
      if (!hasConsent) {
        this.logger.warn(
          `SMS blocked — no consent signal for caller ${callerId} (TCPA gate)`,
        );
        return;
      }
    }
 
    await this.sendWithLogging(callerId, phone, body, messageType);
  }
 
  // ─── Upgrade prompt (service communication — bypasses TCPA) ─────────────────
 
  async sendUpgradePrompt(
    callerId: string,
    phone: string,
    callerName: string | null,
  ): Promise<void> {
    const name = callerName ?? 'there';
    const lines = [
      `Hey ${name} — this is Haven.`,
      "You've used your 10 free minutes for this month.",
      '',
      'To keep talking, choose an option:',
    ];
    if (this.linkPerMinute) lines.push(`• Pay as you go ($0.99/min): ${this.linkPerMinute}`);
    if (this.linkUnlimited) lines.push(`• Unlimited calls ($29.99/mo): ${this.linkUnlimited}`);
    lines.push('', "You're not alone — I'll be here when you're ready.");
 
    await this.sendWithLogging(callerId, phone, lines.join('\n'), 'subscription');
  }
 
  // ─── Subscription confirmation ───────────────────────────────────────────────
 
  async sendSubscriptionConfirmation(
    callerId: string,
    phone: string,
    callerName: string | null,
    tier: 'per_minute' | 'unlimited',
  ): Promise<void> {
    const name = callerName ?? 'Friend';
    const tierLabel = tier === 'unlimited' ? 'Unlimited ($29.99/mo)' : 'Pay As You Go ($0.99/min)';
 
    const lines = [
      `Hey ${name} — you're all set.`,
      '',
      `Your ${tierLabel} plan is now active.`,
      '',
      tier === 'unlimited'
        ? 'You now have unlimited access to Haven. Call anytime.'
        : 'You can now call Haven anytime at $0.99/min. No monthly commitment.',
      '',
      '— Haven',
    ];
 
    await this.sendWithLogging(callerId, phone, lines.join('\n'), 'subscription');
  }
 
  // ─── Free tier warning ───────────────────────────────────────────────────────
 
  async sendFreeMinuteWarning(
    callerId: string,
    phone: string,
    callerName: string | null,
    minutesRemaining: number,
  ): Promise<void> {
    const name = callerName ?? 'Friend';
    const lines = [
      `Hey ${name} — just a heads up from Haven.`,
      '',
      `You have ${minutesRemaining} free minute${minutesRemaining === 1 ? '' : 's'} remaining this month.`,
      '',
      'Want to keep talking without limits?',
    ];
    if (this.linkPerMinute) lines.push(`• Pay as you go ($0.99/min): ${this.linkPerMinute}`);
    if (this.linkUnlimited) lines.push(`• Unlimited calls ($29.99/mo): ${this.linkUnlimited}`);
    lines.push('', "I'm here whenever you need me.");
 
    await this.sendWithLogging(callerId, phone, lines.join('\n'), 'subscription');
  }
 
  // ─── General follow-up (bypasses TCPA — service communication) ──────────────
 
  async sendCallFollowUp(
    callerId: string,
    phone: string,
    callerName: string | null,
    issueSummary: string | null,
  ): Promise<void> {
    const name = callerName ?? 'Friend';
    const lines = [
      `Hey ${name}, this is Haven from UtalkWe Listen.`,
      '',
      'Thank you for calling today. It takes courage to reach out, and I want you to know that what you shared matters.',
    ];
 
    if (issueSummary) {
      lines.push('', "I'm holding space for what you're going through. You don't have to carry it alone.");
    }
 
    lines.push(
      '',
      "If you ever need to talk again, I'm here — anytime.",
      '',
      'Take care of yourself today.',
      '— Haven',
    );
 
    await this.sendWithLogging(callerId, phone, lines.join('\n'), 'follow_up');
  }
 
  // ─── Daily affirmation ───────────────────────────────────────────────────────
 
  async sendDailyAffirmation(
    callerId: string,
    phone: string,
    callerName: string | null,
    isFaith: boolean,
  ): Promise<void> {
    const name = callerName ?? 'Friend';
    const affirmation = isFaith
      ? this.getFaithAffirmation()
      : this.getGeneralAffirmation();
 
    const body = [
      `Good morning, ${name}.`,
      '',
      affirmation,
      '',
      '— Haven',
    ].join('\n');
 
    await this.sendWithLogging(callerId, phone, body, 'daily_wisdom');
  }
 
  private getFaithAffirmation(): string {
    const affirmations = [
      '"The Lord is my shepherd; I shall not want." — Psalm 23:1\nToday, trust that you are being led even when the path is unclear.',
      '"For I know the plans I have for you," declares the Lord, "plans to prosper you and not to harm you." — Jeremiah 29:11\nYou are held. Even now.',
      '"Be strong and courageous. Do not be afraid; do not be discouraged." — Joshua 1:9\nWhatever today brings, you don\'t face it alone.',
      '"Cast all your anxiety on him because he cares for you." — 1 Peter 5:7\nYou don\'t have to carry it all. Let some of it go today.',
      '"His mercies are new every morning; great is his faithfulness." — Lamentations 3:23\nThis is a fresh start. Receive it.',
      '"I can do all things through Christ who strengthens me." — Philippians 4:13\nYou have more strength in you than you know.',
      '"The peace of God, which transcends all understanding, will guard your hearts and minds." — Philippians 4:7\nBreathe. Peace is available to you right now.',
    ];
    return affirmations[Math.floor(Math.random() * affirmations.length)];
  }
 
  private getGeneralAffirmation(): string {
    const affirmations = [
      '"You are allowed to be both a masterpiece and a work in progress."\nGive yourself grace today.',
      '"The only way out is through."\nOne step at a time. You\'re already moving.',
      '"You cannot calm the storm, but you can calm yourself — and the storm will pass."\nBreathe first. Act second.',
      '"What lies behind us and what lies before us are tiny matters compared to what lies within us." — Emerson\nYou have everything you need inside you.',
      '"Start where you are. Use what you have. Do what you can." — Arthur Ashe\nThat is enough for today.',
      '"Almost everything will work again if you unplug it for a few minutes — including you."\nRest is not quitting. Rest is refueling.',
      '"You don\'t have to see the whole staircase. Just take the first step." — MLK Jr.\nToday, just take one step.',
    ];
    return affirmations[Math.floor(Math.random() * affirmations.length)];
  }
 
  // ─── Internals ───────────────────────────────────────────────────────────────
 
  private async hasConsentSignal(callerId: string): Promise<boolean> {
    // Consent = request_coaching_plan was called in any session (sets issue_category)
    const { count, error } = await this.supabase
      .from('call_sessions')
      .select('id', { count: 'exact', head: true })
      .eq('caller_id', callerId)
      .not('issue_category', 'is', null);
 
    if (error) {
      this.logger.error('Consent check failed — blocking SMS as safe default', error);
      return false;
    }
    return (count ?? 0) > 0;
  }
 
  private async sendWithLogging(
    callerId: string,
    phone: string,
    body: string,
    messageType: SmsMessageType,
  ): Promise<void> {
    let twilioSid: string | null = null;
 
    try {
      const msg = await this.client.messages.create({ body, from: this.fromNumber, to: phone });
      twilioSid = msg.sid;
      this.logger.log(`SMS sent to ${this.maskPhone(phone)} [${messageType}] sid=${msg.sid}`);
    } catch (err) {
      this.logger.error(`Twilio send failed to ${this.maskPhone(phone)}`, err);
    }
 
    const status: 'sent' | 'failed' = twilioSid === null ? 'failed' : 'sent';
 
    // Log to sms_log regardless of Twilio result
    const { error: logErr } = await this.supabase.from('sms_log').insert({
      caller_id: callerId,
      phone,
      message_type: messageType,
      body,
      twilio_sid: twilioSid,
      status,
    });
    if (logErr) this.logger.error('Failed to write sms_log entry', logErr);
  }
 
  private maskPhone(phone: string): string {
    if (phone.length < 7) return '***';
    return `${phone.slice(0, 3)}***${phone.slice(-4)}`;
  }
}
