import { z } from "zod";
import { absolutePath, commonInstanceFields } from "@agenvo/connector/config";
export const instanceConfigSchema = z.strictObject({
  ...commonInstanceFields,
  kind: z.literal("herdr"),
  endpoint: absolutePath,
});
export type HerdrConfig = z.infer<typeof instanceConfigSchema>;
