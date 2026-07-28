import * as z from 'zod';

// $id: https://schemas.iscp.dev/json/error.v2.json

export const ERROR_TYPE = 'iscp.error.v2';

export const IscpWireErrorSchema = z.strictObject({
  type: z.literal(ERROR_TYPE),
  code: z.string().regex(/^ISCP[A-Z]+[0-9]{3}$/),
  message: z.string(),
  retryable: z.boolean(),
  request_id: z.string().optional(),
  details: z.record(z.string(), z.string()).optional(),
});
export type IscpWireError = z.infer<typeof IscpWireErrorSchema>;
