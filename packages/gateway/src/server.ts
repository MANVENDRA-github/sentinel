import Fastify from 'fastify';
import type { FastifyServerOptions } from 'fastify';
import { chatCompletionRequestSchema } from './schemas.js';
import { createAuthHook } from './auth.js';
import { GatewayError, ValidationError } from './errors.js';
import type { ProviderRegistry } from './providers/registry.js';

export interface ServerDeps {
  registry: ProviderRegistry;
  apiKeys: ReadonlySet<string>;
  logger?: FastifyServerOptions['logger'];
}

const internalErrorBody = {
  error: { message: 'Internal server error', type: 'internal_error', code: null },
};

/** Builds the Sentinel gateway Fastify app. Dependencies are injected for testability. */
export function buildServer(deps: ServerDeps) {
  const app = Fastify({
    logger: deps.logger ?? {
      redact: {
        paths: ['req.headers.authorization', 'req.headers["x-api-key"]'],
        censor: '[redacted]',
      },
    },
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof GatewayError) {
      return reply.status(error.status).send(error.toBody());
    }
    app.log.error({ err: error }, 'unhandled gateway error');
    return reply.status(500).send(internalErrorBody);
  });

  const authHook = createAuthHook(deps.apiKeys);

  app.post('/v1/chat/completions', { preHandler: authHook }, async (request, reply) => {
    const parsed = chatCompletionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; '),
      );
    }
    const chatRequest = parsed.data;
    const provider = deps.registry.resolve(chatRequest.model);

    if (chatRequest.stream !== true) {
      const result = await provider.chat(chatRequest);
      return reply.status(200).send(result);
    }

    // Streaming: pull the first chunk *before* committing to a 200 SSE response,
    // so an immediate upstream failure still maps to a proper error status.
    const iterator = provider.chatStream(chatRequest)[Symbol.asyncIterator]();
    const first = await iterator.next();

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    try {
      for (let step = first; step.done !== true; step = await iterator.next()) {
        reply.raw.write(`data: ${step.value}\n\n`);
      }
      reply.raw.write('data: [DONE]\n\n');
    } catch (error) {
      const body = error instanceof GatewayError ? error.toBody() : internalErrorBody;
      reply.raw.write(`data: ${JSON.stringify(body)}\n\n`);
    } finally {
      reply.raw.end();
    }
    return reply;
  });

  return app;
}
