import { Inject, Logger, type OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  type OnGatewayConnection,
} from '@nestjs/websockets';
import { decode } from '@auth/core/jwt';
import type { Server, Socket } from 'socket.io';
import { AUTH_SECRET_TOKEN } from '../auth/auth.guard.js';
import { COOKIE_NAMES } from '../auth/cookie-token.js';
import { ExtractionEventsService } from './extraction-events.service.js';

@WebSocketGateway({
  namespace: 'extractions',
  cors: { origin: true, credentials: true },
})
export class ExtractionStatusGateway implements OnGatewayConnection, OnModuleInit {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger(ExtractionStatusGateway.name);

  constructor(
    @Inject(AUTH_SECRET_TOKEN) private readonly secret: string,
    private readonly events: ExtractionEventsService,
  ) {}

  onModuleInit(): void {
    this.events.onEvent((e) => {
      this.server?.to(`ext:${e.extractionId}`).emit('extraction-status', e);
    });
  }

  async handleConnection(client: Socket): Promise<void> {
    const user = await this.verifyClient(client);
    if (!user) {
      client.emit('error', { error: 'unauthorized' });
      client.disconnect(true);
      return;
    }
    client.data.user = user;
  }

  @SubscribeMessage('subscribe-extraction')
  async handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): Promise<{ ok: true } | { error: string }> {
    if (!client.data?.user) return { error: 'unauthorized' };
    const id = extractId(body);
    if (!id) return { error: 'invalid_id' };
    await client.join(`ext:${id}`);
    return { ok: true };
  }

  @SubscribeMessage('unsubscribe-extraction')
  async handleUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): Promise<{ ok: true } | { error: string }> {
    const id = extractId(body);
    if (!id) return { error: 'invalid_id' };
    await client.leave(`ext:${id}`);
    return { ok: true };
  }

  private async verifyClient(client: Socket): Promise<{ id: string } | null> {
    const cookieHeader = client.handshake.headers.cookie;
    if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) return null;
    for (const name of COOKIE_NAMES) {
      const value = readCookieValue(cookieHeader, name);
      if (!value) continue;
      try {
        const payload = await decode({ token: value, secret: this.secret, salt: name });
        if (payload && typeof payload.sub === 'string') {
          return { id: payload.sub };
        }
      } catch {
        // try the next name; Auth.js cookie can come under either form
      }
    }
    return null;
  }
}

function extractId(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const id = (body as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function readCookieValue(header: string, name: string): string | null {
  const prefix = name + '=';
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      return decodeURIComponent(trimmed.slice(prefix.length));
    }
  }
  return null;
}
