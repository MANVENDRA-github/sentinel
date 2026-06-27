import { describe, it, expect } from 'vitest';
import { GatewayError, AuthError, ModelNotFoundError, UpstreamError } from './errors.js';

describe('errors', () => {
  it('maps to an OpenAI-style body', () => {
    const err = new GatewayError(400, 'bad', 'invalid_request_error', 'x');
    expect(err.toBody()).toEqual({
      error: { message: 'bad', type: 'invalid_request_error', code: 'x' },
    });
  });

  it('defaults the code to null', () => {
    expect(new GatewayError(500, 'oops', 'internal_error').toBody().error.code).toBeNull();
  });

  it('AuthError is 401', () => {
    expect(new AuthError().status).toBe(401);
  });

  it('ModelNotFoundError is 404 and names the model', () => {
    const err = new ModelNotFoundError('zzz');
    expect(err.status).toBe(404);
    expect(err.message).toContain('zzz');
  });

  it('UpstreamError passes 4xx through but collapses 5xx to 502', () => {
    expect(new UpstreamError('p', 429, 'rate').status).toBe(429);
    expect(new UpstreamError('p', 500, 'boom').status).toBe(502);
  });

  it('UpstreamError.fromResponse reads the body', async () => {
    const err = await UpstreamError.fromResponse(
      'p',
      new Response('upstream detail', { status: 503 }),
    );
    expect(err.status).toBe(502);
    expect(err.message).toContain('upstream detail');
  });

  it('UpstreamError.fromResponse falls back when the body cannot be read', async () => {
    const res = new Response(null, { status: 500, statusText: 'Server Error' });
    Object.defineProperty(res, 'text', { value: () => Promise.reject(new Error('unreadable')) });
    const err = await UpstreamError.fromResponse('p', res);
    expect(err.status).toBe(502);
    expect(err.message).toContain('Server Error');
  });

  it('UpstreamError.fromResponse uses the status code when status text is empty', async () => {
    const res = new Response(null, { status: 500, statusText: '' });
    Object.defineProperty(res, 'text', { value: () => Promise.reject(new Error('x')) });
    const err = await UpstreamError.fromResponse('p', res);
    expect(err.message).toContain('HTTP 500');
  });
});
