// ─── Access control ─────────────────────────────────────────────────────────

async canAccessCall(callerId: string): Promise<AccessCheckResult> {
  const { data: caller, error } = await this.supabase
    .from('callers')
    .select('subscription_tier')
    .eq('id', callerId)
    .single();

  if (error) throw error;

  const tier = (caller as { subscription_tier: string }).subscription_tier as SubscriptionTier;

  // Unlimited subscribers always get access
  if (tier === 'unlimited') {
    return { allowed: true, tier };
  }

  // Per-minute subscribers always get access (billed per use via Stripe)
  if (tier === 'per_minute') {
    return { allowed: true, tier };
  }

  // Free tier: check minutes used this month
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const { data: sessions, error: sessErr } = await this.supabase
    .from('call_sessions')
    .select('duration_seconds')
    .eq('caller_id', callerId)
    .gte('started_at', startOfMonth.toISOString())
    .not('ended_at', 'is', null);

  if (sessErr) throw sessErr;

  const totalMinutes = (sessions ?? []).reduce(
    (sum, s) => sum + Math.ceil((s.duration_seconds ?? 0) / 60),
    0,
  );

  const freeMinuteLimit = Number.parseInt(
    this.config.get<string>('FREE_CALL_MAX_MINUTES') ?? '10',
    10,
  );

  if (totalMinutes >= freeMinuteLimit) {
    return { allowed: false, tier: 'free', reason: 'free_minutes_exhausted' };
  }

  return { allowed: true, tier: 'free' };
}
