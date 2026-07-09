import { DomainProfileModel } from "./models/domainProfile.js";

/**
 * Website Intelligence Layer read/write (M12 — docs/phase12.md). Consulted at the crawl
 * edges: WRITE an observation after each page, READ the accumulated profile back.
 */

export interface DomainObservation {
  readonly tech: readonly string[];
  readonly renderMode: "http" | "browser";
  readonly statusOk: boolean;
}

export interface DomainProfile {
  readonly domain: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly pagesObserved: number;
  readonly techStack: string[];
  readonly renderModesSeen: string[];
  /** Derived: did any page require the browser? */
  readonly needsRender: boolean;
  readonly lastStatusOk: boolean;
}

/** Raw persisted shape → typed profile with derived fields. Pure; unit-testable. */
export function deriveProfile(doc: {
  _id: string;
  firstSeenAt?: Date | string | null;
  lastSeenAt?: Date | string | null;
  pagesObserved?: number | null;
  techStack?: string[] | null;
  renderModesSeen?: string[] | null;
  lastStatusOk?: boolean | null;
}): DomainProfile {
  const renderModesSeen = doc.renderModesSeen ?? [];
  const iso = (d: Date | string | null | undefined): string =>
    d ? new Date(d).toISOString() : new Date(0).toISOString();
  return {
    domain: doc._id,
    firstSeenAt: iso(doc.firstSeenAt),
    lastSeenAt: iso(doc.lastSeenAt),
    pagesObserved: doc.pagesObserved ?? 0,
    techStack: doc.techStack ?? [],
    renderModesSeen,
    needsRender: renderModesSeen.includes("browser"),
    lastStatusOk: doc.lastStatusOk ?? true,
  };
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
  await DomainProfileModel.updateOne(
    { _id: domain },
    {
      $setOnInsert: { firstSeenAt: new Date() },
      $set: { lastSeenAt: new Date(), lastStatusOk: obs.statusOk },
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
