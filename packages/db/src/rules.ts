import type { ExtractionRule } from "@crawler/shared";
import { RuleModel } from "./models/rule.js";

export type { ExtractionRule };

/** Rule Library metadata (gap-analysis fix #7 / architecture-v3 §2.45): the feedback
 * loop's raw signal. `hitRate` is derived on read, never stored, so it can't drift
 * from the counters it's computed from (same pattern as `deriveProfile`/`needsRender`
 * in the domain-intelligence layer). */
export interface RuleMeta extends ExtractionRule {
  readonly generatedBy: "operator" | "llm";
  readonly version: number;
  readonly hits: number;
  readonly misses: number;
  /** null if never used yet. */
  readonly hitRate: number | null;
  readonly verifiedAt: string | null;
  readonly updatedAt: string;
}

/** Raw persisted rule shape (pre-derivation) — what Mongo actually stores. */
export interface RuleDoc {
  _id: string;
  schemaType: string;
  fields?: Map<string, string> | Record<string, string> | null;
  listItem?: string | null;
  generatedBy?: string | null;
  version?: number | null;
  hits?: number | null;
  misses?: number | null;
  verifiedAt?: Date | string | null;
  updatedAt?: Date | string | null;
}

export type RuleKind = "detail" | "list";

const LIST_KEY_SUFFIX = "#list";

/** Mongo _id for a domain's rule of a given kind (M22). Detail rules keep the
 * bare domain — every pre-M22 doc is a valid detail rule with no migration. */
export function ruleKey(domain: string, kind: RuleKind = "detail"): string {
  return kind === "list" ? `${domain}${LIST_KEY_SUFFIX}` : domain;
}

function toExtractionRule(doc: RuleDoc): ExtractionRule {
  const fields = (doc.fields ? Object.fromEntries(
    doc.fields instanceof Map ? doc.fields : Object.entries(doc.fields),
  ) : {}) as Record<string, string>;
  const isList = doc._id.endsWith(LIST_KEY_SUFFIX);
  return {
    domain: isList ? doc._id.slice(0, -LIST_KEY_SUFFIX.length) : doc._id,
    schemaType: doc.schemaType,
    fields,
    kind: isList ? "list" : "detail",
    listItem: doc.listItem ?? undefined,
  };
}

// Self-heal (M17 — docs/phase17.md): a rule needs a minimum sample size before
// its hit rate is judged (one unlucky miss on a brand-new rule shouldn't nuke
// it), and only regenerates below this threshold — thresholds are conservative
// defaults, not yet tuned against real usage data.
const SELF_HEAL_MIN_SAMPLE = 5;
const SELF_HEAL_HIT_RATE_THRESHOLD = 0.3;

/** Pure: should a rule with this many hits/misses be flagged for regeneration?
 * Unit-testable without Mongo — same pattern as `deriveRuleMeta`. */
export function needsSelfHeal(hits: number, misses: number): boolean {
  const total = hits + misses;
  if (total < SELF_HEAL_MIN_SAMPLE) return false;
  return hits / total < SELF_HEAL_HIT_RATE_THRESHOLD;
}

/** Pure: raw doc → typed meta with hitRate derived from hits/misses. Unit-testable
 * without Mongo — same pattern as `deriveProfile` in the domain-intelligence layer. */
export function deriveRuleMeta(doc: RuleDoc): RuleMeta {
  const hits = doc.hits ?? 0;
  const misses = doc.misses ?? 0;
  const total = hits + misses;
  return {
    ...toExtractionRule(doc),
    generatedBy: doc.generatedBy === "llm" ? "llm" : "operator",
    version: doc.version ?? 1,
    hits,
    misses,
    hitRate: total === 0 ? null : hits / total,
    verifiedAt: doc.verifiedAt ? new Date(doc.verifiedAt).toISOString() : null,
    updatedAt: new Date(doc.updatedAt ?? Date.now()).toISOString(),
  };
}

/** The lean extraction-time read: just what the `rules` plugin needs to run. */
export async function getRulesForDomain(
  domain: string,
  kind: RuleKind = "detail",
): Promise<ExtractionRule | null> {
  const doc = await RuleModel.findById(ruleKey(domain, kind)).lean();
  return doc === null ? null : toExtractionRule(doc);
}

/** The introspection read (API/dashboard): extraction fields + the feedback-loop signal. */
export async function getRuleWithMeta(
  domain: string,
  kind: RuleKind = "detail",
): Promise<RuleMeta | null> {
  const doc = await RuleModel.findById(ruleKey(domain, kind)).lean();
  return doc === null ? null : deriveRuleMeta(doc);
}

/**
 * Create or replace a domain's rule. `$inc: {version: 1}` so every write — including
 * the first — bumps the version (starts at 1).
 *
 * Hit/miss counters ARE reset to 0 here (changed in M17). The original M14 design
 * kept them continuous across regenerations deliberately — but that decision predates
 * self-heal (M17): once something actually *acts* on a low hit rate by clearing the
 * rule, a fresh regeneration inheriting its predecessor's failure history gets judged
 * — and can get cleared again — before it's ever had a real trial. Live testing today
 * caught this directly: a rule regenerated seconds earlier (and working) was
 * immediately self-healed away because the domain's older attempts had accumulated 22
 * misses. A new rule is a new set of selectors; it deserves a clean trial.
 */
export async function upsertRule(
  rule: ExtractionRule,
  opts: { generatedBy?: "operator" | "llm" } = {},
): Promise<void> {
  await RuleModel.updateOne(
    { _id: ruleKey(rule.domain, rule.kind) },
    {
      $set: {
        schemaType: rule.schemaType,
        fields: rule.fields,
        listItem: rule.listItem ?? null,
        generatedBy: opts.generatedBy ?? "operator",
        updatedAt: new Date(),
        hits: 0,
        misses: 0,
      },
      $inc: { version: 1 },
    },
    { upsert: true },
  );
}

/**
 * Self-heal (M17): clear a rule's selectors so the next crawl on this domain sees it
 * exactly as if no rule existed — `rulesPlugin`'s existing `hasFields` check already
 * turns an empty `fields` into `confidence: "none"`, which is the same signal that
 * triggers Tier 4 regeneration (no new "is this rule stale" branch needed anywhere
 * else). `version`/`hits`/`misses`/the document itself are preserved for audit — only
 * the apparently-broken selectors are cleared. Best-effort, like `recordRuleUsage`.
 */
export async function clearStaleRule(
  domain: string,
  kind: RuleKind = "detail",
): Promise<void> {
  await RuleModel.updateOne(
    { _id: ruleKey(domain, kind) },
    { $set: { fields: {}, updatedAt: new Date() } },
  );
}

/**
 * Record whether a rule's extraction succeeded on a page (gap-analysis fix #7). This
 * is the feedback loop's write side. Since M17, it's also the reflex, not just the
 * sensor: after recording the outcome, checks whether the rule's hit rate has fallen
 * below the self-heal threshold and clears it if so — the rule regenerates fresh via
 * Tier 4 next time this domain is crawled with an intent. Atomic-ish (one
 * findOneAndUpdate + one conditional follow-up), best-effort: callers should never let
 * this failure block a crawl (matches `recordDomainObservation`'s convention).
 */
export async function recordRuleUsage(
  domain: string,
  success: boolean,
  kind: RuleKind = "detail",
): Promise<void> {
  const updated = await RuleModel.findOneAndUpdate(
    { _id: ruleKey(domain, kind) },
    success
      ? { $inc: { hits: 1 }, $set: { verifiedAt: new Date() } }
      : { $inc: { misses: 1 } },
    { new: true },
  ).lean();
  if (updated && needsSelfHeal(updated.hits ?? 0, updated.misses ?? 0)) {
    await clearStaleRule(domain, kind);
  }
}
