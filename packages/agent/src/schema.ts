import { z } from 'zod'

/** The fixed hypothesis set the investigation eliminates against. */
export const HYPOTHESES = ['MARKET', 'SECTOR', 'EVENT', 'UNEXPLAINED', 'DATA_ARTIFACT'] as const
export type Hypothesis = (typeof HYPOTHESES)[number]

export const HYPOTHESIS_LABEL: Record<Hypothesis, string> = {
  MARKET: 'Explained by the broad market',
  SECTOR: 'Explained by a sector-wide move',
  EVENT: 'Explained by a company-specific event',
  UNEXPLAINED: 'Idiosyncratic, with no supporting evidence found',
  DATA_ARTIFACT: 'Not a real move — corporate action or bad data',
}

export const verdictSchema = z.enum(['SUPPORTED', 'REJECTED', 'INSUFFICIENT'])

export const findingSchema = z.object({
  hypothesis: z.enum(HYPOTHESES),
  verdict: verdictSchema,
  reason: z.string().min(1).max(400),
  evidence: z.array(z.object({
    type: z.string().min(1).max(40),
    source: z.string().min(1).max(60),
    observation: z.string().min(1).max(300),
    observed_at: z.string().nullable().optional(),
    stance: z.enum(['SUPPORTS', 'CONTRADICTS', 'NEUTRAL']),
  })).max(6),
})
export type Finding = z.infer<typeof findingSchema>

export const conclusionSchema = z.object({
  primary_hypothesis: z.enum(HYPOTHESES),
  /** Shown to the user verbatim. Descriptive only — never predictive. */
  conclusion: z.string().min(10).max(400),
  confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  insufficient_evidence: z.boolean(),
})
export type Conclusion = z.infer<typeof conclusionSchema>

/** Progress stages surfaced in the UI. Each maps to real work, not a timer. */
export const STAGES = [
  'ANALYZING_MOVEMENT',
  'COMPARING_MARKET',
  'CHECKING_SECTOR',
  'INSPECTING_VOLUME',
  'READING_INTRADAY_SHAPE',
  'INVESTIGATING_EVENTS',
  'CHECKING_CORPORATE_ACTIONS',
  'VERIFYING_DATA_HEALTH',
  'RECORDING_FINDING',
  'FORMING_CONCLUSION',
] as const
export type Stage = (typeof STAGES)[number]

export const STAGE_LABEL: Record<Stage, string> = {
  ANALYZING_MOVEMENT: 'Analysing movement',
  COMPARING_MARKET: 'Comparing against the market',
  CHECKING_SECTOR: 'Checking the sector',
  INSPECTING_VOLUME: 'Inspecting volume',
  READING_INTRADAY_SHAPE: 'Reading the intraday shape',
  INVESTIGATING_EVENTS: 'Investigating events',
  CHECKING_CORPORATE_ACTIONS: 'Checking corporate actions',
  VERIFYING_DATA_HEALTH: 'Verifying data health',
  RECORDING_FINDING: 'Recording a finding',
  FORMING_CONCLUSION: 'Forming a conclusion',
}
