import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Catches every exception and adds the request id to the response body
 * so a user reporting "I got a 500" can quote the id from their network
 * tab and the operator can grep one line out of the log stream. The id
 * also goes onto the response header (X-Request-Id) on the same path so
 * a curl-only debugger sees it before parsing JSON.
 *
 * Non-HttpException errors land as 500 with a generic body; the real
 * error class and stack go to the log, never the wire (no information
 * leak about internal types or paths).
 */
@Catch()
export class RequestIdExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(RequestIdExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<FastifyRequest>();
    const reply = ctx.getResponse<FastifyReply>();
    const requestId = String(req.id ?? '');

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const merged = mergeBody(body, requestId);
      void reply.header('X-Request-Id', requestId).status(status).send(merged);
      return;
    }

    this.logger.error(
      exception instanceof Error ? exception.stack : String(exception),
      'unhandled exception',
    );
    void reply.header('X-Request-Id', requestId).status(HttpStatus.INTERNAL_SERVER_ERROR).send({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'internal_error',
      message: 'internal server error',
      requestId,
    });
  }
}

function mergeBody(body: unknown, requestId: string): Record<string, unknown> {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return { ...(body as Record<string, unknown>), requestId };
  }
  return { message: typeof body === 'string' ? body : 'error', requestId };
}
