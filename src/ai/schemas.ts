/** Structured-output schemas for every LLM task (Part 10.4). Validated with zod. */
import { z } from 'zod';

export const Fact = z.object({ entity: z.string().min(1), attribute: z.string().min(1), value: z.string().min(1), confidence: z.number().min(0).max(1).optional() });
export const CompressOut = z.object({
  title: z.string().min(1),
  summary: z.string(),
  sections: z.array(z.object({ heading: z.string(), text: z.string() })),
  facts: z.array(Fact),
  decisions: z.array(z.string()),
  open_questions: z.array(z.string()),
});
export type Structured = z.infer<typeof CompressOut>;

export const SplitOut = z.object({ statements: z.array(z.object({ speaker_label: z.string(), text: z.string().min(1), start_ms: z.number().int().nullable().optional() })) });
export const FactsOut = z.object({ facts: z.array(Fact) });
export const SensCategory = z.enum(['pricing', 'deal_or_fundraising', 'personal_data', 'health', 'hr', 'legal', 'security', 'outsider_identity', 'credentials']);
export const Severity = z.enum(['low', 'medium', 'high']);
export const SensOut = z.object({ flags: z.array(z.object({ category: SensCategory, severity: Severity, reason: z.string() })) });
export type Flag = z.infer<typeof SensOut>['flags'][number];
export const ContradictionOut = z.object({ conflict: z.boolean(), explanation: z.string(), preferred: z.enum(['a', 'b', 'unknown']) });
export const UpdateOut = z.object({
  changes: z.array(z.object({ section_id: z.string().nullable().optional(), op: z.enum(['add', 'edit', 'remove']), heading: z.string().nullable().optional(), new_text: z.string() })),
  rationale: z.string(),
});
export const MergeOut = CompressOut.extend({ mapping: z.record(z.string(), z.string()).optional() });
export const SealedOut = z.object({ answer: z.string(), refused: z.boolean(), refusal_reason: z.string().nullable().optional() });
export const JudgeOut = z.object({ reveals_more_than_needed: z.boolean(), quoted_spans: z.array(z.string()), reason: z.string() });
export const RuleCmdOut = z.object({
  target_ref: z.string(),
  visibility: z.enum(['private', 'team', 'partner', 'public']).nullable().optional(),
  embargo_until: z.string().nullable().optional(),
  expires_at: z.string().nullable().optional(),
  access_mode: z.enum(['viewable', 'agent_only', 'sealed_use']).nullable().optional(),
});
