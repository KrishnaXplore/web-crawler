import { DomainProfileModel } from "./models/domainProfile.js";

/**
 * Website Intelligence Layer read/write (M12 — docs/phase12.md). Consulted at the crawl
 * edges: WRITE an observation after each page, READ the accumulated profile back.
 */

export interface DomainObservation {
  readonly tech: readonly string[];
  readonly renderMode: "http" | "browser";
  readonly statusOk: boolean;
  /** M20: this HTTP-mode fetch looked like a bot-detection challenge — see
   *  packages/crawler-core/src/pipeline/botChallenge.ts. Feeds `needsRender`. */
  readonly httpChallengeDetected?: boolean;
}

/** A learned "this path worked for this ask" shortcut (M18 — Discovery Engine Step B). */
export interface PathHint {
  readonly keywords: readonly string[];
  readonly path: string;
  readonly confirmedAt: string;
}

export interface DomainProfile {
  readonly domain: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly pagesObserved: number;
  readonly techStack: string[];
  readonly renderModesSeen: string[];
  /** Derived: did any page require the browser, OR did HTTP mode get bot-challenged? */
  readonly needsRender: boolean;
  readonly lastStatusOk: boolean;
  readonly pathHints: readonly PathHint[];
  readonly httpChallengeSeen: boolean;
}

const MAX_PATH_HINTS = 20;

/** Raw persisted shape → typed profile with derived fields. Pure; unit-testable. */
export function deriveProfile(doc: {
  _id: string;
  firstSeenAt?: Date | string | null;
  lastSeenAt?: Date | string | null;
  pagesObserved?: number | null;
  techStack?: string[] | null;
  renderModesSeen?: string[] | null;
  lastStatusOk?: boolean | null;
  pathHints?:
    | readonly { keywords?: string[] | null; path: string; confirmedAt?: Date | string | null }[]
    | null;
  httpChallengeSeen?: boolean | null;
}): DomainProfile {
  const renderModesSeen = doc.renderModesSeen ?? [];
  const httpChallengeSeen = doc.httpChallengeSeen ?? false;
  const iso = (d: Date | string | null | undefined): string =>
    d ? new Date(d).toISOString() : new Date(0).toISOString();
  return {
    domain: doc._id,
    firstSeenAt: iso(doc.firstSeenAt),
    lastSeenAt: iso(doc.lastSeenAt),
    pagesObserved: doc.pagesObserved ?? 0,
    techStack: doc.techStack ?? [],
    renderModesSeen,
    needsRender: renderModesSeen.includes("browser") || httpChallengeSeen,
    lastStatusOk: doc.lastStatusOk ?? true,
    pathHints: (doc.pathHints ?? []).map((h) => ({
      keywords: h.keywords ?? [],
      path: h.path,
      confirmedAt: iso(h.confirmedAt),
    })),
    httpChallengeSeen,
  };
}

/**
 * Pure (M18): which of a domain's learned path hints are relevant to *this*
 * crawl's intent — a hint recorded for "mobile phones" shouldn't boost a link
 * for a "laptop deals" crawl on the same domain. Overlap is any shared keyword.
 */
export function matchingPathHints(
  hints: readonly PathHint[],
  intentKeywords: readonly string[],
): PathHint[] {
  if (intentKeywords.length === 0) return [];
  const wanted = new Set(intentKeywords);
  return hints.filter((h) => h.keywords.some((k) => wanted.has(k)));
}

/**
 * Record one page observation for a domain (M12). Atomic operators so N concurrent
 * workers never lose a tech entry and no read-modify-write race exists. Best-effort:
 * the caller should not let a failure here fail the crawl.
 */
export async function recordDomainObservation(
  domain: string,
  obs: DomainObservation,
): Promise<void> {
  const set: Record<string, unknown> = { lastSeenAt: new Date(), lastStatusOk: obs.statusOk };
  // Only ever set true — one challenge sighting is enough evidence; a later
  // unchallenged crawl shouldn't silently erase it (challenges are intermittent
  // by nature, not something a clean fetch disproves).
  if (obs.httpChallengeDetected) set.httpChallengeSeen = true;
  await DomainProfileModel.updateOne(
    { _id: domain },
    {
      $setOnInsert: { firstSeenAt: new Date() },
      $set: set,
      $inc: { pagesObserved: 1 },
      $addToSet: {
        techStack: { $each: [...obs.tech] },
        renderModesSeen: obs.renderMode,
      },
    },
    { upsert: true },
  );
}

/** The accumulated profile for a domain, or null if never crawled. */
export async function getDomainProfile(domain: string): Promise<DomainProfile | null> {
  const doc = await DomainProfileModel.findById(domain).lean();
  return doc === null ? null : deriveProfile(doc);
}

/**
 * Record a learned navigation shortcut (M18 — Discovery Engine Step B): this
 * `path` produced real extraction results for a crawl whose intent had these
 * `keywords`. Capped at the most recent `MAX_PATH_HINTS` via `$push` + `$slice`
 * (a negative slice keeps the *last* N pushed, i.e. the most recent). No
 * de-duplication in this first pass — a path confirming itself repeatedly just
 * appears more than once, which the read side (`matchingPathHints`) treats no
 * differently. Best-effort, same convention as `recordDomainObservation`.
 */
export async function recordPathHint(
  domain: string,
  keywords: readonly string[],
  path: string,
): Promise<void> {
  if (keywords.length === 0) return;
  await DomainProfileModel.updateOne(
    { _id: domain },
    {
      $push: {
        pathHints: {
          $each: [{ keywords: [...keywords], path, confirmedAt: new Date() }],
          $slice: -MAX_PATH_HINTS,
        },
      },
    },
    { upsert: true },
  );
}
