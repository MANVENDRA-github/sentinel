import { createHash } from 'node:crypto';
import type { ChatCompletionRequest } from '../schemas.js';

/**
 * A stable, **model-independent** fingerprint of a request's messages. The same prompt
 * sent to different models (or model versions) shares a fingerprint, which is what lets
 * the regression view group quality scores for one prompt across models over time.
 */
export function promptFingerprint(request: ChatCompletionRequest): string {
  return createHash('sha256').update(JSON.stringify(request.messages)).digest('hex').slice(0, 16);
}
