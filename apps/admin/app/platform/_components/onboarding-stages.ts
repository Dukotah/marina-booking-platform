/**
 * The onboarding pipeline, as a client-safe module.
 *
 * These literals mirror the `OnboardingStage` enum in schema.prisma. They live here
 * rather than being imported from Prisma because the stage control is a client
 * component, and pulling the generated Prisma client into the browser bundle to read
 * six strings would be absurd. The server action re-validates against this same list,
 * so the two can never drift apart silently.
 */

/** The happy path, in order. A client walks left to right. */
export const PIPELINE_STAGES = ['LEAD', 'PROVISIONED', 'CONFIGURING', 'TESTING', 'LIVE'] as const;

/** Off the pipeline: a client who stopped. Kept separate so it never reads as "progress". */
export const TERMINAL_STAGES = ['CHURNED'] as const;

export const ALL_STAGES = [...PIPELINE_STAGES, ...TERMINAL_STAGES] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];
export type OnboardingStageValue = (typeof ALL_STAGES)[number];

/** Plain-language names. The owner reads these, not the enum. */
export const STAGE_LABEL: Record<OnboardingStageValue, string> = {
  LEAD: 'Lead',
  PROVISIONED: 'Provisioned',
  CONFIGURING: 'Configuring',
  TESTING: 'Testing',
  LIVE: 'Live',
  CHURNED: 'Churned',
};

/** One sentence saying what this stage actually means, shown under the control. */
export const STAGE_MEANING: Record<OnboardingStageValue, string> = {
  LEAD: 'Talking to them. Nothing has been built yet.',
  PROVISIONED: 'Their account exists. Setup has not really started.',
  CONFIGURING: 'We are loading their activities, rates, and branding.',
  TESTING: 'They are trying it out. Test bookings, not real money.',
  LIVE: 'Taking real bookings from real customers.',
  CHURNED: 'They stopped. Kept for the record.',
};

export function isStageValue(value: unknown): value is OnboardingStageValue {
  return typeof value === 'string' && (ALL_STAGES as readonly string[]).includes(value);
}

/** Position on the pipeline, or -1 for a stage that is not on it (CHURNED). */
export function stageIndex(stage: OnboardingStageValue): number {
  return (PIPELINE_STAGES as readonly string[]).indexOf(stage);
}
