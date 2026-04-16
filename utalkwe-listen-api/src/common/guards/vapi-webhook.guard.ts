import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class VapiWebhookGuard implements CanActivate {
  private readonly logger = new Logger(VapiWebhookGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('VAPI_WEBHOOK_SECRET');

    // If no secret is configured, allow all requests (dev/testing mode)
    if (!expected) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();
    const incoming = request.headers['x-vapi-secret'];

    if (!incoming || incoming !== expected) {
      this.logger.warn('Webhook rejected — invalid or missing x-vapi-secret header');
      throw new UnauthorizedException('Invalid webhook secret');
    }
    return true;
  }
}
