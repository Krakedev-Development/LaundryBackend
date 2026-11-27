import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  sound?: 'default' | null;
  data?: Record<string, unknown>;
  channelId?: string;
  priority?: 'default' | 'normal' | 'high';
}

export interface ExpoPushTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_PUSH_TOKEN_RE = /^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/;
const EXPO_BATCH_SIZE = 100;

export function isExpoPushToken(token: string): boolean {
  return EXPO_PUSH_TOKEN_RE.test(token.trim());
}

/** Dispatches push notifications via the Expo Push API and deactivates invalid tokens. */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async sendToExpoApi(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]> {
    if (
      messages.length === 0 ||
      process.env.NODE_ENV === 'test' ||
      this.config.get<string>('PUSH_ENABLED') === 'false'
    ) {
      return [];
    }

    const accessToken = this.config.get<string>('EXPO_ACCESS_TOKEN')?.trim();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    };

    const tickets: ExpoPushTicket[] = [];
    for (let i = 0; i < messages.length; i += EXPO_BATCH_SIZE) {
      const batch = messages.slice(i, i + EXPO_BATCH_SIZE);
      try {
        const res = await fetch(EXPO_PUSH_URL, {
          method: 'POST',
          headers,
          body: JSON.stringify(batch),
        });
        if (!res.ok) {
          this.logger.warn(`Expo Push API respondió ${res.status}`);
          continue;
        }
        const json = (await res.json()) as { data?: ExpoPushTicket[] };
        if (Array.isArray(json.data)) {
          tickets.push(...json.data);
        }
      } catch (err) {
        this.logger.warn(
          `Error enviando push a Expo: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return tickets;
  }

  async sendToUsers(
    userIds: string[],
    input: {
      title: string;
      body: string;
      data?: Record<string, unknown>;
      channelId?: string;
    },
  ): Promise<void> {
    const uniqueIds = Array.from(
      new Set(userIds.map((id) => id.trim()).filter(Boolean)),
    );
    if (uniqueIds.length === 0) return;

    try {
      const devices = await this.prisma.deviceToken.findMany({
        where: { userId: { in: uniqueIds }, active: true },
        select: { token: true },
      });
      const validTokens = devices
        .map((d) => d.token)
        .filter((token) => isExpoPushToken(token));
      if (validTokens.length === 0) return;

      const messages: ExpoPushMessage[] = validTokens.map((to) => ({
        to,
        title: input.title,
        body: input.body,
        sound: 'default',
        priority: 'high',
        ...(input.channelId ? { channelId: input.channelId } : {}),
        ...(input.data ? { data: input.data } : {}),
      }));

      const tickets = await this.sendToExpoApi(messages);
      const invalidTokens: string[] = [];
      for (let i = 0; i < tickets.length; i++) {
        const ticket = tickets[i];
        const token = messages[i]?.to;
        if (
          token &&
          ticket?.status === 'error' &&
          ticket.details?.error === 'DeviceNotRegistered'
        ) {
          invalidTokens.push(token);
        }
      }
      if (invalidTokens.length > 0) {
        await this.prisma.deviceToken.updateMany({
          where: { token: { in: invalidTokens } },
          data: { active: false },
        });
      }
    } catch (err) {
      this.logger.warn(
        `No se pudo despachar push a usuarios: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
