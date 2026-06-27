import { z } from 'zod';

/**
 * A single chat message. Permissive on content shape; `passthrough` preserves
 * provider-specific fields so they reach the upstream untouched.
 */
export const chatMessageSchema = z
  .object({
    role: z.string().min(1),
    content: z.union([z.string(), z.array(z.unknown()), z.null()]).optional(),
  })
  .passthrough();

/**
 * The OpenAI `/v1/chat/completions` request subset Sentinel validates.
 * Unknown fields pass through, so any provider-specific parameter still works.
 */
export const chatCompletionRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(chatMessageSchema).min(1),
    stream: z.boolean().optional(),
    temperature: z.number().min(0).optional(),
    max_tokens: z.number().int().positive().optional(),
  })
  .passthrough();

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;
