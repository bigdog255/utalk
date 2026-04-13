import { Body, Controller, HttpCode, Logger, Post, UseGuards } from '@nestjs/common';
import { VapiWebhookGuard } from '../common/guards/vapi-webhook.guard';
import { VapiService } from './vapi.service';
import type { VapiWebhookPayload } from './vapi.types';

@Controller('vapi')
export class VapiController {
  private readonly logger = new Logger(VapiController.name);

  constructor(private readonly vapiService: VapiService) {}

  @Post('webhook')
  @UseGuards(VapiWebhookGuard)
  @HttpCode(200)
  async handleWebhook(@Body() payload: VapiWebhookPayload): Promise<unknown> {
    const message = payload?.message;
    const type = message?.type;
    const phone = message?.call?.customer?.number ?? '';
    const vapiCallId = message?.call?.id ?? '';

    this.logger.log(`Webhook received: type=${type ?? 'unknown'} callId=${vapiCallId} phone=${phone || 'EMPTY'}`);

    // Log raw call structure for end-of-call-report debugging
    if (type === 'end-of-call-report') {
      this.logger.log(`end-of-call-report call keys: ${JSON.stringify(Object.keys(message?.call ?? {}))}`);
      this.logger.log(`end-of-call-report customer: ${JSON.stringify(message?.call?.customer ?? 'MISSING')}`);
    }

    // Log function call details for debugging
    if (type === 'function-call') {
      const fnName = message?.functionCall?.name ?? 'unknown';
      this.logger.log(`Function call: ${fnName} params=${JSON.stringify(message?.functionCall?.parameters ?? {})}`);
    }

    try {
      switch (type) {
        case 'assistant-request':
          return await this.vapiService.buildDynamicAssistant(phone, vapiCallId);

        case 'call-start':
          await this.vapiService.onCallStart(phone, vapiCallId);
          return { received: true };

        case 'end-of-call-report':
          await this.vapiService.onCallEnd(message);
          return { received: true };

        case 'function-call':
          return await this.vapiService.handleFunctionCall(message);

        // Vapi may also send tool-calls in newer API versions
        case 'tool-calls': {
          this.logger.log('Received tool-calls type — routing as function-call');
          return await this.vapiService.handleFunctionCall(message);
        }

        default:
          this.logger.log(`Unhandled webhook type: ${type}`);
          return { received: true };
      }
    } catch (err) {
      // HTTP 200 always — errors are logged, never surfaced as non-200 responses
      this.logger.error(`Webhook error [type=${type ?? 'unknown'}]`, err);
      return { received: true };
    }
  }
}
