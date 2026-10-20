import { z } from "zod";
export const configSchema = z.object({
  profile: z.union([z.literal(60), z.literal(90)]),
  initialMs: z.number().int().min(2000),
  gapMs: z.number().int().min(2000),
  finalMs: z.number().int().nonnegative(),
  reserveMs: z.number().int().nonnegative(),
  mode: z.enum(["optimize", "order"]),
  maxTapes: z.number().int().min(1).max(1000).nullable(),
  seed: z.number().int(),
});
export const occurrenceSchema = z.object({
  id: z.string().max(160),
  trackId: z.string().max(160),
  sourceId: z.string().max(160),
  revision: z.string().max(160),
  durationMs: z.number().int().nonnegative(),
  title: z.string().max(2000),
  artist: z.string().max(2000),
  kind: z.enum(["local", "youtube"]),
  videoId: z.string().optional(),
});
export const planSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(160),
  createdAt: z.string(),
  config: configSchema,
  sides: z
    .array(
      z.object({
        id: z.string(),
        tape: z.number().int().positive(),
        face: z.enum(["A", "B"]),
        tracks: z.array(occurrenceSchema),
        programMs: z.number(),
        occupiedMs: z.number(),
        freeMs: z.number(),
      }),
    )
    .max(2000),
  excluded: z.array(
    z.object({ id: z.string(), title: z.string(), reason: z.string() }),
  ),
  optimality: z.enum(["proven", "unproven"]),
  algorithm: z.string(),
});
