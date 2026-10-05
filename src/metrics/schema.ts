import { z } from "zod";
import { metricKeys } from "./definitions";

const probabilityMapSchema = z.record(z.string(), z.number().min(0).max(1));

const noulAnswerSchema = z
  .object({
    type: z.literal("noul"),
    noul: z.number().min(0).max(1),
  })
  .passthrough();

const choiceAnswerSchema = z
  .object({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: probabilityMapSchema,
    confidence: z.number().min(0).max(1),
  })
  .passthrough();

const scoreAnswerSchema = z
  .object({
    type: z.literal("score"),
    score: z.number().min(0).max(9),
    legend: z.record(z.string(), z.string()),
    probabilities: probabilityMapSchema,
    confidence: z.number().min(0).max(1),
  })
  .passthrough();

export const jevResponseSchema = z
  .object({
    model: z.string(),
    answers: z.record(
      z.string(),
      z.discriminatedUnion("type", [noulAnswerSchema, choiceAnswerSchema, scoreAnswerSchema]),
    ),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative(),
      })
      .passthrough(),
  })
  .passthrough();

const severitySchema = z.enum(["low", "medium", "high"]);

const metricIssueSchema = z
  .object({
    severity: severitySchema,
    description: z.string(),
    location: z.string().optional(),
    suggestion: z.string().optional(),
  })
  .strict();

const metricEvaluationSchema = z
  .object({
    applicable: z.boolean(),
    score: z.number().min(1).max(10).optional(),
    confidence: z.number().min(0).max(1).optional(),
    summary: z.string().optional(),
    issues: z.array(metricIssueSchema).optional(),
  })
  .strict()
  .superRefine((metric, context) => {
    if (metric.applicable && (metric.score === undefined || metric.confidence === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Applicable metrics require score and confidence",
      });
    }
    if (!metric.applicable && (metric.score !== undefined || metric.confidence !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Non-applicable metrics cannot include score or confidence",
      });
    }
  });

const metricsShape = Object.fromEntries(
  metricKeys.map((key) => [key, metricEvaluationSchema]),
) as Record<(typeof metricKeys)[number], typeof metricEvaluationSchema>;

const comparisonEntrySchema = z
  .object({
    metric: z.enum(metricKeys),
    previousScore: z.number().min(1).max(10),
    currentScore: z.number().min(1).max(10),
    delta: z.number().min(-9).max(9),
    direction: z.enum(["improved", "regressed", "unchanged"]),
  })
  .strict();

export const evaluationSchema = z
  .object({
    metrics: z.object(metricsShape).strict(),
    priorities: z.array(
      z
        .object({
          metric: z.enum(metricKeys),
          severity: severitySchema,
          reason: z.string(),
        })
        .strict(),
    ),
    improvements: z.array(z.string()).optional(),
    regressions: z.array(z.string()).optional(),
    comparison: z.array(comparisonEntrySchema).optional(),
  })
  .strict();

export type JevResponse = z.infer<typeof jevResponseSchema>;
export type Severity = z.infer<typeof severitySchema>;
export type MetricIssue = z.infer<typeof metricIssueSchema>;
export type MetricEvaluation = z.infer<typeof metricEvaluationSchema>;
export type ComparisonEntry = z.infer<typeof comparisonEntrySchema>;
export type Evaluation = z.infer<typeof evaluationSchema>;
