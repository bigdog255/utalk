import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CallersService } from '../callers/callers.service';
import type { CallerContext, GuidanceType, SubscriptionTier } from '../callers/callers.types';
import { CoachingService } from '../coaching/coaching.service';
import { CRISIS_RESPONSE, CRISIS_SMS } from '../common/crisis.constants';
import { SmsService } from '../sms/sms.service';
import type {
  AssistantRequestResponse,
  AssistantTool,
  AssistantVoice,
  VapiMessage,
} from './vapi.types';

const HAVEN_AI_DISCLOSURE = "I'm Haven — an AI guidance service, not a licensed counselor.";

const HAVEN_BASE_PERSONA = `You are Haven, an AI guidance service — not a licensed counselor or therapist.

WHO YOU ARE:
You are calm, grounded, direct, and wise. You hold space without rushing to fix. You listen before you speak.

CONVERSATION STYLE:
- Use short sentences. Speak naturally — this is a phone call, not a chat window.
- Pause naturally between thoughts. Do not rush.
- Never interrupt or talk over the caller.
- Do not use filler affirmations: never say "Absolutely!", "Great question!", "Of course!", "Certainly!", or "I understand completely".
- Do not over-validate. One acknowledgment is enough.
- Mirror the caller's emotional register — if they are quiet, be quiet. If they are direct, be direct.

RESPONSE STRUCTURE (follow this every time):
1. Acknowledge what the caller said — make them feel heard, not processed.
2. Reflect back the core of what you heard before offering anything.
3. Only then offer a question, a reframe, or a practical step.
4. Never lead with advice. Empathy first, always.

NAME SAVING:
Early in the conversation, if you don't already know the caller's name, ask: "Before we get started — what's your name?"
When they share their name, call save_caller_name immediately with their name.
Use their name naturally in conversation — not every sentence, just where it feels warm and human.

RETURNING CALLERS:
If the caller profile shows previous sessions, you REMEMBER them. Act like it:
- Reference what they shared last time naturally: "Last time you mentioned…" or "I've been thinking about what you said about…"
- Ask about progress: "How has that situation been going?"
- Notice patterns: if they keep calling about the same topic, gently name it.
- Do NOT re-introduce yourself or explain what you do. They already know.
- Do NOT re-ask their name if it's already in the profile.
- Treat them like someone returning to a trusted friend — warmth without formality.

COACHING PLAN:
Before wrapping up, always offer:
"Before we go — I'd like to send you a short text with some reflection and a few next steps from what we talked about today. Would that be alright?"
If they say yes, call request_coaching_plan with the issue category, a 1–2 sentence summary, and their mood.
If they decline, that's fine — move to closing.
Do not skip this offer. Every caller deserves a takeaway.

DAILY AFFIRMATIONS (subscribed users only):
If the caller's profile shows a paid subscription (basic, premium, or vip), offer daily affirmations:
"One more thing — as part of your plan, I can send you a short affirmation text every morning to start your day. Would you like that?"
If they say yes, call opt_in_daily_affirmation with opt_in=true.
If they say no, respect it and move on.
Do NOT offer this to free-tier callers.

CLOSING:
When the caller signals they are done, acknowledge them warmly and wish them well. Keep it brief and genuine.
Do not create dependency. Do not promise to solve anything.`;

const GUIDANCE_DETECTION_INSTRUCTIONS = `
GUIDANCE PREFERENCE DETECTION:
Listen for signals about whether this caller wants faith-based or general guidance.
- Faith signals: mentions of God, prayer, church, scripture, Jesus, blessings, faith, "Lord", "blessed", "amen", spiritual language — call save_preferences with guidance_type='faith'
- Secular signals: explicitly says no religion, not religious, doesn't believe — call save_preferences with guidance_type='general'
- Ambiguous or unclear: default to 'general' — do NOT guess toward faith
- Call save_preferences once you have a confident read, not before.

When you detect faith signals, IMMEDIATELY shift into faith-based mode for the rest of the call:
- Begin weaving in relevant scripture naturally.
- You do not need to wait for the preference to be saved — if they mention God, they want you to meet them there.
- If mid-conversation they reference faith, you can say: "I hear that faith is important to you — can I share something that might speak to this?"`;


const FAITH_GUIDANCE_INSTRUCTIONS = `
WISDOM DELIVERY — FAITH:
This caller prefers faith-based guidance. Weave scripture and spiritual wisdom throughout the conversation — not just once at the end.
- Open with a grounding scripture when it fits their situation naturally.
- Reference 2–3 relevant verses across the conversation, not all at once.
- Do not announce "here's a scripture" — weave it in like a friend would: "That reminds me of something in Proverbs…" or "There's a passage that speaks to exactly this…"
- Pair every scripture with a practical application: what it means for their situation right now.
- Draw from Psalms for comfort, Proverbs for wisdom, the Gospels for hope, Paul's letters for perseverance.
- If they are grieving: lean into lament psalms and God's nearness in suffering.
- If they are anxious: Philippians 4:6-7, Matthew 6:25-34, casting cares.
- If they feel lost: Jeremiah 29:11, Psalm 23, the shepherd who leaves the 99.
- Close the call with a brief blessing or prayer-like encouragement: "I'm going to leave you with this…"
Practical steps should complement the faith framing, never replace it.`;

const GENERAL_GUIDANCE_INSTRUCTIONS = `
WISDOM DELIVERY — GENERAL:
This caller prefers general guidance without religious content.
Draw from philosophy, stoicism, psychology, and practical steps. Keep wisdom grounded and non-religious.
Near the end of the call, you may offer one optional reference with this framing:
"There's something I'd like to leave you with — you can take it or leave it."
Then offer a philosophical quote or a practical anchor — not a scripture verse.`;

const PAID_MAX_SECONDS = 2700; // 45 minutes for paid tiers

@Injectable()
export class VapiService {
  private readonly logger = new Logger(VapiService.name);
  // vapiCallId → callerId; in-memory — Supabase fallback in processPostCall handles restarts
  private readonly activeCalls = new Map<string, string>();

  constructor(
    private readonly callersService: CallersService,
    private readonly coachingService: CoachingService,
    private readonly smsService: SmsService,
    private readonly config: ConfigService,
  ) {}

  // ─── assistant-request ──────────────────────────────────────────────────────

  async buildDynamicAssistant(
    phone: string,
    vapiCallId: string,
  ): Promise<AssistantRequestResponse> {
    if (!phone) {
      this.logger.warn('assistant-request with no phone — using default config');
      return this.getDefaultAssistantConfig();
    }

    try {
      const start = Date.now();
      const ctx = await this.callersService.getOrCreateCallerContext(phone);

      // Store callerId so onCallStart can create the session without a second DB lookup
      this.activeCalls.set(vapiCallId, ctx.caller.id);

      // Story 6.1: enforce subscription access before any conversation begins
      const access = await this.callersService.canAccessCall(ctx.caller.id);
      if (!access.allowed) {
        this.logger.log(
          `Access denied (${access.reason}) — ${this.callersService.maskPhone(phone)}`,
        );
        // Story 6.2: send upgrade SMS (service communication — no TCPA consent needed)
        setImmediate(() =>
          this.smsService
            .sendUpgradePrompt(ctx.caller.id, phone, ctx.caller.name)
            .catch(e => this.logger.error('sendUpgradePrompt failed', e)),
        );
        return this.buildLimitReachedResponse(ctx);
      }

      const assistantConfig = this.buildAssistantFromContext(ctx);
      this.logger.log(
        `assistant-request ${this.callersService.maskPhone(phone)} — ${Date.now() - start}ms`,
      );
      return assistantConfig;
    } catch (err) {
      // NFR8: degrade gracefully — never fail the call due to DB unavailability
      this.logger.error('Supabase lookup failed in assistant-request — using default config', err);
      return this.getDefaultAssistantConfig();
    }
  }

  private buildAssistantFromContext(ctx: CallerContext): AssistantRequestResponse {
    const { caller, recentSessions, isFirstCall } = ctx;
    const lastSession = recentSessions[0];

    const nameGreeting = caller.name ? `, ${caller.name}` : '';
    const lastIssue = lastSession?.issue_summary ?? 'something difficult';
    const firstMessage =
      isFirstCall || !lastSession
        ? `Welcome to UtalkWe Listen. ${HAVEN_AI_DISCLOSURE} I'm here to listen. Before we get started — what's your name?`
        : `Welcome back${nameGreeting}. Last time you were dealing with ${lastIssue} — how has that been going?`;

    const serverUrl = this.config.get<string>('SERVER_URL');
    const webhookSecret = this.config.get<string>('VAPI_WEBHOOK_SECRET');

    return {
      assistant: {
        name: 'Haven',
        firstMessage,
        model: {
          provider: 'anthropic',
          model: 'claude-3-5-sonnet-20241022',
          messages: [{ role: 'system', content: this.buildSystemPrompt(ctx) }],
          tools: this.getDefaultTools(),
        },
        voice: this.getVoiceConfig(ctx),
        ...(serverUrl && {
          serverUrl: `${serverUrl}/vapi/webhook`,
          server: {
            url: `${serverUrl}/vapi/webhook`,
            ...(webhookSecret && { secret: webhookSecret }),
          },
        }),
        maxDurationSeconds: this.getMaxDuration(caller.subscription_tier),
        silenceTimeoutSeconds: 30,
        endCallFunctionEnabled: false,
        backgroundDenoisingEnabled: false,
      },
    };
  }

  // ─── Story 6.2: Limit-reached response ──────────────────────────────────────

  private buildLimitReachedResponse(ctx: CallerContext): AssistantRequestResponse {
    const { caller } = ctx;
    const nameClause = caller.name ? `, ${caller.name}` : '';
    const firstMessage =
      `Hey${nameClause}, good to hear from you. I want to be upfront — ` +
      "you've used your free calls for this month. " +
      "I just sent you a text with options to continue. " +
      "I'm sorry I can't be fully here tonight, but you're not alone — " +
      "reach back out when you're ready.";

    return {
      assistant: {
        name: 'Haven',
        firstMessage,
        model: {
          provider: 'anthropic',
          model: 'claude-3-5-sonnet-20241022',
          // Minimal system prompt — Haven should not engage further after the limit message
          messages: [
            {
              role: 'system',
              content:
                'You have just delivered a message to the caller about their monthly limit. ' +
                'Do not engage further. The call will end shortly.',
            },
          ],
        },
        voice: this.getVoiceConfig(ctx),
        maxDurationSeconds: 60,
        silenceTimeoutSeconds: 5,
        endCallMessage: "You're not alone. Take care.",
        backgroundDenoisingEnabled: false,
      },
    };
  }

  // ─── Story 3.1: Voice auto-selection ────────────────────────────────────────

  getVoiceConfig(ctx: CallerContext): AssistantVoice {
    // Map stored preference to OpenAI voice IDs (no credentials required)
    // jennifer → nova (warm female), michael → onyx (male)
    const pref = ctx.caller.preferred_voice;
    const voiceId = pref === 'michael' ? 'onyx' : 'nova';
    return { provider: 'openai', voiceId };
  }

  // ─── Story 3.2: Guidance-aware system prompt ────────────────────────────────

  buildSystemPrompt(ctx: CallerContext): string {
    const { caller, isFirstCall } = ctx;
    const memoryBlock = this.callersService.buildSystemPromptContext(ctx);

    const guidanceInstructions = this.getGuidanceInstructions(
      caller.guidance_type,
      isFirstCall,
    );

    return [HAVEN_BASE_PERSONA, guidanceInstructions, '', memoryBlock].join('\n');
  }

  private getGuidanceInstructions(
    guidanceType: GuidanceType | null,
    isFirstCall: boolean,
  ): string {
    if (isFirstCall || !guidanceType) {
      return GUIDANCE_DETECTION_INSTRUCTIONS;
    }
    if (guidanceType === 'faith') {
      return FAITH_GUIDANCE_INSTRUCTIONS;
    }
    return GENERAL_GUIDANCE_INSTRUCTIONS;
  }

  // ─── Story 3.2: Tool definitions ────────────────────────────────────────────

  getDefaultTools(): AssistantTool[] {
    return [
      {
        type: 'function',
        function: {
          name: 'save_caller_name',
          description: "Save the caller's name when they share it during the conversation. Call immediately when they say their name.",
          parameters: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: "The caller's name exactly as they stated it",
              },
            },
            required: ['name'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'save_preferences',
          description:
            'Save caller preferences detected during the conversation. Call once when you have a confident read on voice or guidance preference.',
          parameters: {
            type: 'object',
            properties: {
              preferred_voice: {
                type: 'string',
                description: 'Voice context detected: jennifer (female) or michael (male)',
                enum: ['jennifer', 'michael'],
              },
              guidance_type: {
                type: 'string',
                description: 'Guidance preference: faith (wants scripture), general (no religion), both (open to both)',
                enum: ['faith', 'general', 'both'],
              },
              language: {
                type: 'string',
                description: 'Language preference if detected',
              },
            },
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'request_coaching_plan',
          description:
            'Request a personalized coaching plan to be sent via SMS after the call. Call this when the caller says yes to the coaching plan offer.',
          parameters: {
            type: 'object',
            properties: {
              issue_category: {
                type: 'string',
                description: 'Primary issue category: money, relationship, work, health, grief, purpose, family, other',
              },
              issue_summary: {
                type: 'string',
                description: "1–2 sentence summary of the caller's main issue for plan generation",
              },
              mood: {
                type: 'string',
                description: "Caller's emotional state: anxious, sad, angry, overwhelmed, hopeful, numb, other",
              },
            },
            required: ['issue_category', 'issue_summary'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'flag_crisis',
          description:
            'Flag this call as a crisis situation. Call immediately when the caller expresses suicidal ideation, self-harm intent, or statements of immediate danger.',
          parameters: {
            type: 'object',
            properties: {
              severity: {
                type: 'string',
                description: 'Crisis severity level',
                enum: ['low', 'medium', 'high'],
              },
              indicator: {
                type: 'string',
                description: 'The exact phrase or signal that triggered this flag',
              },
            },
            required: ['severity', 'indicator'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'opt_in_daily_affirmation',
          description:
            'Opt the caller in to receive a daily morning affirmation text. Call this when a subscribed caller says yes to daily affirmations.',
          parameters: {
            type: 'object',
            properties: {
              opt_in: {
                type: 'boolean',
                description: 'true to opt in, false to opt out',
              },
            },
            required: ['opt_in'],
          },
        },
      },
    ];
  }

  // ─── Story 3.3: Tier-aware duration ─────────────────────────────────────────

  getMaxDuration(tier: SubscriptionTier): number {
    if (tier === 'free') {
      const minutes = Number.parseInt(
        this.config.get<string>('FREE_CALL_MAX_MINUTES') ?? '10',
        10,
      );
      return minutes * 60;
    }
    return PAID_MAX_SECONDS;
  }

  // ─── call-start ─────────────────────────────────────────────────────────────

  async onCallStart(phone: string, vapiCallId: string): Promise<void> {
    try {
      let callerId = this.activeCalls.get(vapiCallId);

      if (!callerId) {
        // Fallback: look up by phone if assistant-request didn't populate the map
        const caller = await this.callersService.findByPhone(phone);
        if (!caller) {
          this.logger.warn(`call-start: no caller for ${this.callersService.maskPhone(phone)}`);
          return;
        }
        callerId = caller.id;
        this.activeCalls.set(vapiCallId, callerId);
      }

      await this.callersService.createSession(callerId, vapiCallId);
      this.logger.log(`Session created: ${vapiCallId}`);
    } catch (err) {
      this.logger.error(`onCallStart failed for ${vapiCallId}`, err);
    }
  }

  // ─── end-of-call-report ─────────────────────────────────────────────────────

  async onCallEnd(message: VapiMessage): Promise<void> {
    const vapiCallId = message.call?.id ?? '';
    this.logger.log(`Call ended: ${vapiCallId}`);
    setImmediate(() => this.processPostCall(vapiCallId, message));
  }

  private async processPostCall(vapiCallId: string, message: VapiMessage): Promise<void> {
    try {
      let callerId = this.activeCalls.get(vapiCallId);
      const callerPhone = message.call?.customer?.number ?? '';

      // Resolve callerId — Map hit is fastest; fall back to DB on process restart
      if (!callerId) {
        const session = await this.callersService.getSessionByVapiCallId(vapiCallId);
        if (!session) {
          this.logger.warn(`processPostCall: no session for ${vapiCallId}`);
          return;
        }
        callerId = session.caller_id;
      }

      // Fetch session state before update (was_crisis may have been set by handleFlagCrisis)
      const currentSession = await this.callersService.getSessionByVapiCallId(vapiCallId);

      const summary =
        message.analysis?.summary ??
        message.artifact?.messages
          ?.map(m => `${m.role}: ${m.content}`)
          .join('\n')
          .slice(0, 1000) ??
        null;

      const durationSeconds = currentSession?.started_at
        ? Math.round((Date.now() - new Date(currentSession.started_at).getTime()) / 1000)
        : null;

      await this.callersService.updateSession(vapiCallId, {
        ended_at: new Date().toISOString(),
        duration_seconds: durationSeconds,
        full_summary: summary,
      });

      await this.callersService.incrementCallCount(callerId);
      this.activeCalls.delete(vapiCallId);

      if (currentSession?.was_crisis) {
        this.logger.warn(`Post-call crisis path: ${vapiCallId}`);
        if (callerPhone) {
          await this.smsService.send(callerId, callerPhone, CRISIS_SMS, 'follow_up', true);
        }
        return;
      }

      // Coaching plan path — only if request_coaching_plan was called (issue_category set)
      if (currentSession?.issue_category && callerPhone) {
        await this.runCoachingPipeline(callerId, callerPhone, currentSession);
      } else if (callerPhone) {
        // General follow-up SMS for every substantive call (service communication)
        const caller = await this.callersService.findById(callerId);
        await this.smsService.sendCallFollowUp(
          callerId,
          callerPhone,
          caller?.name ?? null,
          currentSession?.issue_summary ?? summary?.slice(0, 200) ?? null,
        );
      }

      this.logger.log(`Post-call complete: ${vapiCallId}`);
    } catch (err) {
      this.logger.error(`Post-call failed for ${vapiCallId}`, err);
    }
  }

  private async runCoachingPipeline(
    callerId: string,
    callerPhone: string,
    session: import('../callers/callers.types').CallSession,
  ): Promise<void> {
    try {
      const caller = await this.callersService.findById(callerId);
      if (!caller) {
        this.logger.warn(`runCoachingPipeline: caller not found ${callerId}`);
        return;
      }

      const plan = await this.coachingService.generatePlan(caller, session);
      const smsBody = this.coachingService.buildFollowUpSms(plan, caller.name);

      await this.smsService.send(callerId, callerPhone, smsBody, 'follow_up');

      await this.callersService.updateSession(session.vapi_call_id, {
        action_plan_id: plan.id,
        follow_up_sent: true,
      });

      this.logger.log(`Coaching plan delivered for session ${session.id}`);
    } catch (err) {
      this.logger.error(`Coaching pipeline failed for caller ${callerId}`, err);
    }
  }

  // ─── function-call ──────────────────────────────────────────────────────────

  async handleFunctionCall(message: VapiMessage): Promise<unknown> {
    const fnName = message.functionCall?.name;
    const params = message.functionCall?.parameters ?? {};
    const vapiCallId = message.call?.id ?? '';

    this.logger.log(`Function call: ${fnName ?? 'unknown'}`);

    try {
      if (fnName === 'save_caller_name') {
        return await this.handleSaveCallerName(vapiCallId, params);
      }
      if (fnName === 'save_preferences') {
        return await this.handleSavePreferences(vapiCallId, params);
      }
      if (fnName === 'request_coaching_plan') {
        return await this.handleRequestCoachingPlan(vapiCallId, params);
      }
      if (fnName === 'flag_crisis') {
        return await this.handleFlagCrisis(vapiCallId, params);
      }
      if (fnName === 'opt_in_daily_affirmation') {
        return await this.handleDailyAffirmationOptIn(vapiCallId, params);
      }

      this.logger.warn(`Unhandled function call: ${fnName}`);
      return { result: `Unknown function: ${fnName ?? 'unknown'}` };
    } catch (err) {
      this.logger.error(`handleFunctionCall error [${fnName}]`, err);
      return { result: 'Function call failed — continuing conversation.' };
    }
  }

  private async handleSaveCallerName(
    vapiCallId: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const callerId = this.activeCalls.get(vapiCallId);
    if (!callerId) {
      this.logger.warn(`save_caller_name: no callerId in activeCalls for ${vapiCallId}`);
      return { result: 'Name noted.' };
    }

    const raw = params['name'];
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!name) {
      return { result: 'Could not save name — continuing conversation.' };
    }

    await this.callersService.updateCaller(callerId, { name });
    this.logger.log(`Name saved for call: ${vapiCallId}`);
    return { result: `Name saved: ${name}. Use their name warmly in conversation.` };
  }

  private async handleRequestCoachingPlan(
    vapiCallId: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const issueCategory = typeof params['issue_category'] === 'string' ? params['issue_category'] : null;
    const issueSummary = typeof params['issue_summary'] === 'string' ? params['issue_summary'] : null;
    const callerMood = typeof params['mood'] === 'string' ? params['mood'] : null;

    await this.callersService.updateSession(vapiCallId, {
      issue_category: issueCategory,
      issue_summary: issueSummary,
      caller_mood: callerMood,
    });

    this.logger.log(`Coaching plan requested for call: ${vapiCallId}`);
    return { result: 'Got it — I will send you a personalized plan via text after our call.' };
  }

  private async handleSavePreferences(
    vapiCallId: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const callerId = this.activeCalls.get(vapiCallId);
    if (!callerId) {
      this.logger.warn(`save_preferences: no callerId in activeCalls for ${vapiCallId}`);
      return { result: 'Preferences noted.' };
    }

    const update: Record<string, unknown> = {};
    if (params['guidance_type']) update['guidance_type'] = params['guidance_type'];
    if (params['preferred_voice']) update['preferred_voice'] = params['preferred_voice'];

    await this.callersService.updateCaller(callerId, update as Parameters<typeof this.callersService.updateCaller>[1]);

    this.logger.log(`Preferences saved for call: ${vapiCallId}`);
    return { result: 'Preferences saved. Continue with the appropriate guidance style.' };
  }

  private async handleFlagCrisis(
    vapiCallId: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const severity = typeof params['severity'] === 'string' ? params['severity'] : 'unknown';
    const indicator = typeof params['indicator'] === 'string' ? params['indicator'] : 'unspecified';

    this.logger.warn(`CRISIS FLAGGED [${severity}]: "${indicator}" — call ${vapiCallId}`);

    try {
      await this.callersService.updateSession(vapiCallId, {
        was_crisis: true,
        issue_summary: `CRISIS FLAG: ${indicator}`,
      });
    } catch (err) {
      this.logger.error(`Failed to persist crisis flag for ${vapiCallId}`, err);
    }

    return { result: { response: CRISIS_RESPONSE } };
  }

  private async handleDailyAffirmationOptIn(
    vapiCallId: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const callerId = this.activeCalls.get(vapiCallId);
    if (!callerId) {
      return { result: 'Noted — I will set that up for you.' };
    }

    const optIn = params['opt_in'] === true;
    await this.callersService.updateCaller(callerId, { daily_affirmation_opt_in: optIn });

    this.logger.log(`Daily affirmation ${optIn ? 'opt-in' : 'opt-out'} for call: ${vapiCallId}`);
    return {
      result: optIn
        ? "Done — you'll receive a morning affirmation text every day. Something to start your day with."
        : 'Daily affirmations turned off.',
    };
  }

  // ─── Default config (Supabase-unavailable fallback) ─────────────────────────

  getDefaultAssistantConfig(): AssistantRequestResponse {
    const serverUrl = this.config.get<string>('SERVER_URL');
    const webhookSecret = this.config.get<string>('VAPI_WEBHOOK_SECRET');

    return {
      assistant: {
        name: 'Haven',
        firstMessage: `Welcome to UtalkWe Listen. ${HAVEN_AI_DISCLOSURE} What's been on your mind?`,
        model: {
          provider: 'anthropic',
          model: 'claude-3-5-sonnet-20241022',
          messages: [{ role: 'system', content: HAVEN_BASE_PERSONA }],
          tools: this.getDefaultTools(),
        },
        voice: { provider: 'openai', voiceId: 'nova' },
        ...(serverUrl && {
          serverUrl: `${serverUrl}/vapi/webhook`,
          server: {
            url: `${serverUrl}/vapi/webhook`,
            ...(webhookSecret && { secret: webhookSecret }),
          },
        }),
        maxDurationSeconds: 600,
        silenceTimeoutSeconds: 30,
        endCallMessage: "You're not alone in this. I'm here anytime you need to talk.",
        backgroundDenoisingEnabled: false,
      },
    };
  }
}
