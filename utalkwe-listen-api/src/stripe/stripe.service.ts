import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import type { SubscriptionTier } from '../callers/callers.types';
import { SUPABASE_CLIENT } from '../supabase/supabase.module';
import type { PriceToTierMap } from './stripe.types';

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  readonly stripe: Stripe;
  private readonly webhookSecret: string;
  private readonly priceToTier: PriceToTierMap;

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly config: ConfigService,
  ) {
    this.stripe = new Stripe(config.getOrThrow<string>('STRIPE_SECRET_KEY'));
    this.webhookSecret = config.getOrThrow<string>('STRIPE_WEBHOOK_SECRET');
    this.priceToTier = {
      [config.getOrThrow<string>('STRIPE_PRICE_PER_MINUTE')]: 'per_minute',
      [config.getOrThrow<string>('STRIPE_PRICE_UNLIMITED')]: 'unlimited',
    };
  }

  constructEvent(rawBody: Buffer, signature: string): Stripe.Event {
    return this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
  }

  async handleEvent(event: Stripe.Event): Promise<void> {
    switch (event.type) {
      case 'checkout.session.completed':
        await this.onCheckoutCompleted(event.data.object);
        break;
      case 'customer.subscription.updated':
        await this.onSubscriptionUpdated(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await this.onSubscriptionDeleted(event.data.object);
        break;
      case 'invoice.payment_failed':
        await this.onPaymentFailed(event.data.object);
        break;
      default:
        this.logger.debug(`Unhandled Stripe event: ${event.type}`);
    }
  }

  // ─── checkout.session.completed ─────────────────────────────────────────────

  private async onCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    const callerId = session.client_reference_id;
    const stripeCustomerId = this.resolveId(session.customer);
    const stripeSubscriptionId = this.resolveId(session.subscription);

    if (!callerId || !stripeCustomerId || !stripeSubscriptionId) {
      this.logger.warn('checkout.session.completed missing required fields', {
        callerId,
        stripeCustomerId,
        stripeSubscriptionId,
      });
      return;
    }

    const subscription = await this.stripe.subscriptions.retrieve(stripeSubscriptionId);
    const tier = this.tierFromSubscription(subscription);

    const { error: callerErr } = await this.supabase
      .from('callers')
      .update({ subscription_tier: tier, stripe_customer_id: stripeCustomerId })
      .eq('id', callerId);
    if (callerErr) this.logger.error('Failed to update caller tier', callerErr);

    const { error: subErr } = await this.supabase.from('subscriptions').upsert(
      {
        caller_id: callerId,
        stripe_subscription_id: stripeSubscriptionId,
        stripe_customer_id: stripeCustomerId,
        tier,
        status: subscription.status,
        current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
      },
      { onConflict: 'stripe_subscription_id' },
    );
    if (subErr) this.logger.error('Failed to upsert subscription record', subErr);

    this.logger.log(`Checkout complete: caller ${callerId} → tier ${tier}`);
  }

  // ─── customer.subscription.updated ──────────────────────────────────────────

  private async onSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
    const stripeCustomerId = this.resolveId(subscription.customer);
    const tier = this.tierFromSubscription(subscription);
    const currentPeriodEnd = new Date(subscription.current_period_end * 1000).toISOString();

    const { error: subErr } = await this.supabase
      .from('subscriptions')
      .update({ status: subscription.status, tier, current_period_end: currentPeriodEnd })
      .eq('stripe_subscription_id', subscription.id);
    if (subErr) this.logger.error('Failed to update subscription record', subErr);

    if (stripeCustomerId) {
      const { error: callerErr } = await this.supabase
        .from('callers')
        .update({ subscription_tier: tier })
        .eq('stripe_customer_id', stripeCustomerId);
      if (callerErr) this.logger.error('Failed to update caller tier on subscription update', callerErr);
    }

    this.logger.log(`Subscription updated: ${subscription.id} → ${tier} (${subscription.status})`);
  }

  // ─── customer.subscription.deleted ──────────────────────────────────────────

  private async onSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
    const stripeCustomerId = this.resolveId(subscription.customer);

    const { error: subErr } = await this.supabase
      .from('subscriptions')
      .update({ status: 'canceled' })
      .eq('stripe_subscription_id', subscription.id);
    if (subErr) this.logger.error('Failed to cancel subscription record', subErr);

    if (stripeCustomerId) {
      const { error: callerErr } = await this.supabase
        .from('callers')
        .update({ subscription_tier: 'free' })
        .eq('stripe_customer_id', stripeCustomerId);
      if (callerErr) this.logger.error('Failed to revert caller to free', callerErr);
    }

    this.logger.log(`Subscription canceled: ${subscription.id} — caller reverted to free`);
  }

  // ─── invoice.payment_failed ──────────────────────────────────────────────────

  private async onPaymentFailed(invoice: Stripe.Invoice): Promise<void> {
    const stripeSubscriptionId = this.resolveId(invoice.subscription);
    if (!stripeSubscriptionId) return;

    const { error } = await this.supabase
      .from('subscriptions')
      .update({ status: 'past_due' })
      .eq('stripe_subscription_id', stripeSubscriptionId);
    if (error) this.logger.error('Failed to mark subscription past_due', error);

    this.logger.warn(`Payment failed — subscription ${stripeSubscriptionId} marked past_due`);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private tierFromSubscription(subscription: Stripe.Subscription): SubscriptionTier {
    const priceId = subscription.items.data[0]?.price.id;
    if (priceId) {
      const tier = this.priceToTier[priceId];
      if (tier) return tier;
    }
    // Default to per_minute if price not recognized
    return 'per_minute';
  }

  private resolveId(obj: string | { id: string } | null | undefined): string | null {
    if (!obj) return null;
    return typeof obj === 'string' ? obj : obj.id;
  }
}
