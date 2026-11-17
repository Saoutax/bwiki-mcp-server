import { z } from 'zod';

const ErrorEnvelopeSchema = z.object({
    category: z.enum([
        'not_found',
        'permission_denied',
        'invalid_input',
        'conflict',
        'authentication',
        'rate_limited',
        'upstream_failure',
    ]),
    message: z.string(),
    code: z.string().optional(),
});
type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

export { ErrorEnvelopeSchema };
export type { ErrorEnvelope };
