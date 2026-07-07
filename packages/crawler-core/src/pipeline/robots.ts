/**
 * Minimal robots.txt parser (workflow.md Phase 4.1) — enough for polite crawling:
 * per-user-agent Allow/Disallow groups with longest-match precedence, plus
 * Crawl-delay (which feeds the per-domain rate limiter, Phase 4.3).
 *
 * This is a pure text parser; fetching robots.txt over the network (through the
 * SSRF guard) is a separate concern.
 */

interface Rule {
  readonly allow: boolean;
  readonly path: string;
}

interface Group {
  readonly agents: string[];
  readonly rules: Rule[];
  delay: number | null;
}

export class RobotsRules {
  constructor(
    private readonly rules: readonly Rule[],
    /** Seconds between requests, if the matched group specified Crawl-delay. */
    readonly crawlDelay: number | null,
  ) {}

  /**
   * Whether `path` (an absolute path like `/a/b?c=1`) may be fetched. Longest
   * matching rule wins; on an equal-length tie, Allow beats Disallow. No matching
   * rule means allowed.
   */
  isAllowed(path: string): boolean {
    let best: Rule | null = null;
    for (const rule of this.rules) {
      if (!pathMatches(rule.path, path)) continue;
      if (
        best === null ||
        rule.path.length > best.path.length ||
        (rule.path.length === best.path.length && rule.allow && !best.allow)
      ) {
        best = rule;
      }
    }
    return best === null ? true : best.allow;
  }
}

export function parseRobots(txt: string, userAgent: string): RobotsRules {
  const ua = userAgent.toLowerCase();
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") continue;

    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "user-agent") {
      // Consecutive User-agent lines share the next block of rules.
      if (!lastWasAgent || current === null) {
        current = { agents: [], rules: [], delay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }

    lastWasAgent = false;
    if (current === null) continue;

    if (field === "disallow") {
      // An empty Disallow imposes no restriction.
      if (value !== "") current.rules.push({ allow: false, path: value });
    } else if (field === "allow") {
      if (value !== "") current.rules.push({ allow: true, path: value });
    } else if (field === "crawl-delay") {
      const n = Number(value);
      if (!Number.isNaN(n)) current.delay = n;
    }
  }

  const group = selectGroup(groups, ua);
  return group
    ? new RobotsRules(group.rules, group.delay)
    : new RobotsRules([], null);
}

/** Pick the group with the longest agent token matching our UA, else the `*` group. */
function selectGroup(groups: readonly Group[], ua: string): Group | null {
  let best: Group | null = null;
  let bestLen = -1;
  let star: Group | null = null;

  for (const g of groups) {
    for (const agent of g.agents) {
      if (agent === "*") {
        star ??= g;
      } else if (ua.includes(agent) && agent.length > bestLen) {
        best = g;
        bestLen = agent.length;
      }
    }
  }
  return best ?? star;
}

/** Match a robots path pattern (supporting `*` wildcard and `$` end-anchor). */
function pathMatches(pattern: string, path: string): boolean {
  if (pattern === "") return false;

  let anchoredEnd = false;
  let p = pattern;
  if (p.endsWith("$")) {
    anchoredEnd = true;
    p = p.slice(0, -1);
  }

  const escaped = p
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp("^" + escaped + (anchoredEnd ? "$" : "")).test(path);
}
