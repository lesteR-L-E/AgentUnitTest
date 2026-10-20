import { z } from "zod";

/**
 * 源码位置（行列号从 1 开始）。对应 v1 SourceLocation。
 */
export const SourceLocationSchema = z.object({
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative().optional(),
  startColumn: z.number().int().nonnegative().optional(),
  endColumn: z.number().int().nonnegative().optional(),
});

export type SourceLocation = z.infer<typeof SourceLocationSchema>;
