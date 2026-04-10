import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../supabase/supabase.module';
import type {
  AccessCheckResult,
  Caller,
  CallerContext,
  CallerUpdate,
  CallSession,
  SessionUpdate,
} from './callers.types';

@Injectable()
export class CallersService {
  private readonly logger = new Logger(CallersService.name);
  private readonly freeCallsPerMonth: number;

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly config: ConfigService,
  ) {
    this.freeCallsPerMonth = Number.parseInt(
      this.config.get<string>('FREE_CALLS_PER_MONTH') ?? '3',
      10,
    );
  }

  // ─── Phone masking ──────────────────────────────────────────────────────────

  maskPhone(phone: string): string {
    if (phone.length < 7) return '***';
    return `${phone.slice(0, 3)}***${phone.slice(-4)}`;
  }

  // ─── Caller CRUD ────────────────────────────────────────────────────────────

  async findById(id: string): Promise<Caller | null> {
    const { data, error } = await this.supabase
      .from('callers')
      .select('*')
      .eq('id', id)
      .single();

    if (error?.code === 'PGRST116') return null;
    if (error) throw error;
    return data as Caller;
  }

  async findAffirmationOptedIn(): Promise<Caller[]> {
    const { data, error } = await this.supabase
      .from('callers')
      .select('*')
      .eq('daily_affirmation_opt_in', true);

    if (error) throw error;
    return (data ?? []) as Caller[];
  }

  async findByPhone(phone: string): Promise<Caller | null> {
    const { data, error } = await this.supabase
      .from('callers')
      .select('*')
      .eq('phone', phone)
      .single();

    if (error?.code === 'PGRST116') return null; // not found
    if (error) throw error;
    return data as Caller;
  }

  async createCaller(phone: string): Promise<Caller> {
    const { data, error } = await this.supabase
      .from('callers')
      .insert({ phone })
      .select()
      .single();

    if (error) throw error;
    this.logger.log(`New caller created: ${this.maskPhone(phone)}`);
    return data as Caller;
  }

  async updateCaller(id: string, updates: CallerUpdate): Promise<Caller> {
    const { data, error } = await this.supabase
      .from('callers')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data as Caller;
  }

  async incrementCallCount(callerId: string): Promise<void> {
    const { error } = await this.supabase.rpc('increment_call_count', {
      caller_id_input: callerId,
    });

    if (error) {
      // Fallback: manual increment if RPC not available
      const { data: caller, error: fetchErr } = await this.supabase
        .from('callers')
        .select('call_count')
        .eq('id', callerId)
        .single();

      if (fetchErr) throw fetchErr;

      const { error: updateErr } = await this.supabase
        .from('callers')
        .update({ call_count: (caller as { call_count: number }).call_count + 1 })
        .eq('id', callerId);

      if (updateErr) throw updateErr;
    }
  }

  // ─── Session CRUD ───────────────────────────────────────────────────────────

  async createSession(callerId: string, vapiCallId: string): Promise<CallSession> {
    const { data, error } = await this.supabase
      .from('call_sessions')
      .insert({ caller_id: callerId, vapi_call_id: vapiCallId })
      .select()
      .single();

    if (error) throw error;
    return data as CallSession;
  }

  async updateSession(vapiCallId: string, updates: SessionUpdate): Promise<void> {
    const { error } = await this.supabase
      .from('call_sessions')
      .update(updates)
      .eq('vapi_call_id', vapiCallId);

    if (error) throw error;
  }

  async getSessionByVapiCallId(vapiCallId: string): Promise<CallSession | null> {
    const { data, error } = await this.supabase
      .from('call_sessions')
      .select('*')
      .eq('vapi_call_id', vapiCallId)
      .single();

    if (error?.code === 'PGRST116') return null;
    if (error) throw error;
    return data as CallSession;
  }

  async getRecentSessions(callerId: string, limit: number): Promise<CallSession[]> {
    const { data, error } = await this.supabase
      .from('call_sessions')
      .select('*')
      .eq('caller_id', callerId)
      .not('ended_at', 'is', null) // completed sessions only
      .order('started_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return (data ?? []) as CallSession[];
  }

  // ─── Context building ───────────────────────────────────────────────────────

  async getOrCreateCallerContext(phone: string): Promise<CallerContext> {
    const existing = await this.findByPhone(phone);
    const isFirstCall = existing === null;
    const caller: Caller = isFirstCall ? await this.createCaller(phone) : existing;

    const recentSessions = isFirstCall
      ? []
      : await this.getRecentSessions(caller.id, 3);

    return { caller, recentSessions, isFirstCall };
  }

  buildSystemPromptContext(ctx: CallerContext): string {
    const { caller, recentSessions, isFirstCall } = ctx;
    const lastSession = recentSessions[0];

    const lines: string[] = [
      'CALLER PROFILE:',
      `- Phone: ${this.maskPhone(caller.phone)}`,
      `- Name: ${caller.name ?? 'not provided'}`,
      `- Guidance preference: ${caller.guidance_type ?? 'not set'}`,
      `- Subscription: ${caller.subscription_tier}`,
      `- Daily affirmations: ${caller.daily_affirmation_opt_in ? 'opted in' : 'not enrolled'}`,
      `- Total calls: ${caller.call_count}`,
    ];

    if (!isFirstCall && lastSession) {
      lines.push(
        '',
        'RETURNING CALLER — You have spoken with this person before. USE this context:',
        `- Last issue: ${lastSession.issue_summary ?? 'not recorded'}`,
        `- Last session: ${(lastSession.full_summary ?? '').slice(0, 200)}`,
        `- Sessions on file: ${recentSessions.length}`,
      );

      if (recentSessions.length > 1) {
        const topics = recentSessions
          .map(s => s.issue_summary)
          .filter(Boolean)
          .slice(0, 3);
        if (topics.length > 0) {
          lines.push(`- Recent topics: ${topics.join('; ')}`);
        }
      }

      lines.push(
        '',
        'IMPORTANT: You know this caller. Greet them warmly by name. Reference their previous conversations.',
        'Do NOT ask their name again. Do NOT introduce yourself as if this is their first time.',
      );
    }

    return lines.join('\n');
  }

  // ─── Access control ─────────────────────────────────────────────────────────

  async canAccessCall(callerId: string): Promise<AccessCheckResult> {
    const { data: caller, error } = await this.supabase
      .from('callers')
      .select('subscription_tier')
      .eq('id', callerId)
      .single();

    if (error) throw error;

    const tier = (caller as { subscription_tier: string }).subscription_tier as
      import('./callers.types').SubscriptionTier;

    if (tier !== 'free') {
      return { allowed: true, tier };
    }

    // Count calls this calendar month
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const { count, error: countErr } = await this.supabase
      .from('call_sessions')
      .select('id', { count: 'exact', head: true })
      .eq('caller_id', callerId)
      .gte('started_at', startOfMonth.toISOString());

    if (countErr) throw countErr;

    if ((count ?? 0) >= this.freeCallsPerMonth) {
      return { allowed: false, tier: 'free', reason: 'free_limit_reached' };
    }

    return { allowed: true, tier: 'free' };
  }
}
