import { z } from "zod";

/**
 * Protocol identifiers are deliberately URL-safe so they may be used in invite
 * links. Leading `-`/`_` must stay legal: relay room ids are base64url hashes,
 * so about one room in sixteen starts with one of them.
 */
export const protocolIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-][A-Za-z0-9._:-]*$/, "must be a URL-safe identifier");

export const roomIdSchema = protocolIdSchema;
export const peerIdSchema = protocolIdSchema;
export const entityIdSchema = protocolIdSchema;
export const isoDateTimeSchema = z.string().datetime({ offset: true });
export const extensionsSchema = z.record(z.unknown());

export const sourceReferenceSchema = z
  .object({
    sourceId: entityIdSchema,
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    excerpt: z.string().max(2_000).optional(),
  })
  .strict()
  .superRefine((reference, context) => {
    if (reference.end < reference.start) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["end"],
        message: "end must be greater than or equal to start",
      });
    }
  });

export type SourceReferenceV1 = z.infer<typeof sourceReferenceSchema>;
