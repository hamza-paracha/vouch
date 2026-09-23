import { z } from "zod";
import { reviewPath } from "./diff.ts";
const base = z.string().min(1).max(200);
const file = z.string().min(1).max(500).refine(reviewPath, "Use an eligible repository-relative file path");
export const reviewChangeSchema = z.object({ base: base.default("HEAD~1"), focus: z.array(file).min(1).max(20).optional() }).strict();
export const assessPrSchema = z.object({ base: base.default("main"), title: z.string().max(500).optional(), description: z.string().max(2000).optional() }).strict();
export const checkFileSchema = z.object({ file, base: base.default("HEAD") }).strict();
export type ReviewAction = "review_change" | "assess_pr" | "check_file";
export const thresholdsSchema = z.object({ high: z.number().min(0.5).max(1).default(0.9), medium: z.number().min(0.5).max(1).default(0.7) })
  .refine(value => value.high > value.medium, "High threshold must exceed medium threshold");
export type Thresholds = z.infer<typeof thresholdsSchema>;
