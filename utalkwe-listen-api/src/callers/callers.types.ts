export type GuidanceType = 'faith' | 'general' | 'both';
export type SubscriptionTier = 'free' | 'per_minute' | 'unlimited';

export interface Caller {
  id: string;
  phone: string;
  name: string | null;
  guidance_type: GuidanceType | null;
  preferred_voice: string | null;
  call_count: number;
  subscription_tier: SubscriptionTier;
  stripe_customer_id: string | null;
  daily_affirmation_opt_in: boolean;
  created_at: string;
  updated_at: string;
}

export interface CallSession {
  id: string;
  caller_id: string;
  vapi_call_id: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  issue_category: string | null;
  issue_summary: string | null;
  full_summary: string | null;
  caller_mood: string | null;
  wisdom_used: string[] | null;
  was_crisis: boolean;
  action_plan_id: string | null;
  follow_up_sent: boolean;
  created_at: string;
}

export interface CallerContext {
  caller: Caller;
  recentSessions: CallSession[];
  isFirstCall: boolean;
}

export interface AccessCheckResult {
  allowed: boolean;
  tier: SubscriptionTier;
  reason?: 'free_limit_reached' | 'free_minutes_exhausted';
}

export type CallerUpdate = Partial
  Pick
    Caller,
    | 'name'
    | 'guidance_type'
    | 'preferred_voice'
    | 'subscription_tier'
    | 'stripe_customer_id'
    | 'daily_affirmation_opt_in'
  >
>;

export type SessionUpdate = Partial
  Pick
    CallSession,
    | 'ended_at'
    | 'duration_seconds'
    | 'issue_category'
    | 'issue_summary'
    | 'full_summary'
    | 'caller_mood'
    | 'wisdom_used'
    | 'was_crisis'
    | 'action_plan_id'
    | 'follow_up_sent'
  >
>;
