import { z } from "zod";
import { FIELD_TYPES } from "../shared/types.ts";

export const FieldInputSchema = z.object({
  id: z.string().uuid().optional(),
  key: z.string(),
  label: z.string(),
  type: z.enum(FIELD_TYPES),
  description: z.string().default(""),
  required: z.boolean().default(false),
  options: z
    .object({
      choices: z.array(z.string()).optional(),
      currency: z.string().optional(),
      component: z.string().optional(),
    })
    .default({}),
});

export const ComponentInputSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string().default(""),
  aiHint: z.string().default(""),
  color: z.string().optional(),
  fields: z.array(FieldInputSchema),
});

const DraftValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const DraftComponentSchema = z.object({
  component: z.string(),
  values: z.record(z.string(), DraftValueSchema),
});

export const DraftSchema = z.object({
  title: z.string(),
  documentDate: z.string().nullable().default(null),
  components: z.array(DraftComponentSchema),
  newComponents: z.array(ComponentInputSchema).default([]),
  newObjects: z
    .array(z.object({ tempId: z.string(), title: z.string(), components: z.array(DraftComponentSchema) }))
    .default([]),
});
