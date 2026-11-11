// The monthly adoption check (docs/contributor/adoption-metrics.md, #690, #700): reads npm, GitHub,
// Google Search Console, Bing Webmaster Tools and Context7 through their APIs for one month, lists
// what looks wrong, and prints the month's row for the page. It only reads, apart from the Context7
// refresh that --refresh-context7 asks for and the traffic log that --traffic-log writes.
//
//   node scripts/adoption-check.ts --month 2026-10 [--traffic-log <file>] [--refresh-context7]
//     [--skip-inspection]
//
// GitHub keeps traffic for 14 days only. --traffic-log merges each day's views and clones into a
// JSON file and keeps a dated copy of the 14-day referrers and popular paths, so a run every week
// loses nothing.
//
// npm and Context7's state need no credentials. GitHub: the gh CLI, signed in with push access to
// the repository. Google: a read-only service account that the maintainer impersonates with gcloud,
// named by ADOPTION_GSC_SERVICE_ACCOUNT, so no key file exists. Bing and the Context7 refresh: an
// API key from BING_WEBMASTER_API_KEY and CONTEXT7_API_KEY, or on macOS from the login Keychain
// items bing-webmaster-api and context7-api. A source without credentials is skipped. No key is
// printed: Bing takes its key in the query string, so every error names the URL with the key
// redacted.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** The repository, for the GitHub API. */
export const REPOSITORY = "aelmanaa/hardhat-kms";

/** The published packages, in the order of the row's downloads column. */
export const PACKAGES = [
  "hardhat-kms",
  "@hardhat-kms/aws",
  "@hardhat-kms/gcp",
  "@hardhat-kms/azure",
  "@hardhat-kms/turnkey",
  "@hardhat-kms/safe",
] as const;

/** The npm searches whose positions the row records. */
export const NPM_SEARCHES = ["hardhat kms", "hardhat safe"] as const;

const NPM_DOWNLOADS = "https://api.npmjs.org/downloads";
const NPM_REGISTRY = "https://registry.npmjs.org";

/** Days after which a sitemap that a console has not read again is a problem. */
const SITEMAP_STALE_DAYS = { google: 7, bing: 14 } as const;

/** The days GitHub keeps traffic for. */
export const TRAFFIC_DAYS = 14;

/** Sitemap URLs checked at once for a 200. */
const URL_CHECK_CONCURRENCY = 8;

/** The docs site, a URL-prefix property in both consoles. */
export const SITE = "https://aelmanaa.github.io/hardhat-kms/";

/** The library's id on Context7. */
export const CONTEXT7_LIBRARY = "/aelmanaa/hardhat-kms";

const GSC = "https://searchconsole.googleapis.com";
const BING = "https://ssl.bing.com/webmaster/api.svc/json";
const CONTEXT7 = "https://context7.com/api/v1";

/** URL Inspection calls in flight at once; each takes a few seconds, and the quota is 600 a minute. */
const INSPECTION_CONCURRENCY = 6;

/** How many queries and pages to print. */
const TOP = 10;

/** The first and last day of a month, as `YYYY-MM-DD`. */
export interface MonthRange {
  start: string;
  end: string;
}

/**
 * The first and last day of a month.
 *
 * @param month - The month as `YYYY-MM`.
 * @returns Its first and last day.
 */
export function monthRange(month: string): MonthRange {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (match === null) {
    throw new Error(`--month must be YYYY-MM, such as 2026-10; got "${month}"`);
  }
  const year = Number(match[1]);
  const index = Number(match[2]);
  const last = new Date(Date.UTC(year, index, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, "0")}` };
}

/**
 * The URLs a sitemap lists.
 *
 * @param xml - The sitemap.
 * @returns Each `<loc>`, in order.
 */
export function sitemapUrls(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((match) => match[1] ?? "");
}

/**
 * Replaces the value of an `apikey` query parameter, so an error can name the URL.
 *
 * @param url - A request URL.
 * @returns The URL with `apikey=<redacted>`.
 */
export function redactKey(url: string): string {
  return url.replace(/([?&]apikey=)[^&\s]*/gi, "$1<redacted>");
}

/** One property of a parsed JSON value, or undefined. */
function get(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const field: unknown = Reflect.get(value, key);
  return field;
}

/** An array of a parsed JSON value, or an empty one. */
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value.map((item: unknown) => item) : [];
}

/** A number of a parsed JSON value, or 0. */
function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** A string of a parsed JSON value, or the fallback. */
function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * The day of a Bing date, which the JSON API writes as `/Date(<ms>)/` or `/Date(<ms>-0700)/`. Bing
 * writes the year 1, a negative number, for a date it does not have, such as a page never crawled.
 *
 * @param value - The date as Bing wrote it.
 * @returns The UTC day as `YYYY-MM-DD`, or undefined for no date or anything else.
 */
export function bingDay(value: unknown): string | undefined {
  const match = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(str(value));
  const ms = match === null ? Number.NaN : Number(match[1]);
  return Number.isFinite(ms) && ms >= 0 ? new Date(ms).toISOString().slice(0, 10) : undefined;
}

/**
 * When Bing last crawled a URL.
 *
 * @param response - The parsed answer of `GetUrlInfo`.
 * @returns The day, or undefined when Bing has not crawled it.
 */
export function bingLastCrawled(response: unknown): string | undefined {
  return bingDay(get(get(response, "d"), "LastCrawledDate"));
}

/** Clicks and impressions. */
export interface Traffic {
  clicks: number;
  impressions: number;
}

/**
 * Sums Bing's daily traffic rows over a month.
 *
 * @param response - The parsed answer of `GetRankAndTrafficStats`.
 * @param range - The month.
 * @returns The month's clicks and impressions, and how many days Bing reported.
 */
export function bingMonthTraffic(response: unknown, range: MonthRange): Traffic & { days: number } {
  const total = { clicks: 0, impressions: 0, days: 0 };
  for (const row of list(get(response, "d"))) {
    const day = bingDay(get(row, "Date"));
    if (day !== undefined && day >= range.start && day <= range.end) {
      total.clicks += num(get(row, "Clicks"));
      total.impressions += num(get(row, "Impressions"));
      total.days += 1;
    }
  }
  return total;
}

/**
 * The pages Bing last reported in its index, from the latest day of `GetCrawlStats` up to the end
 * of a month.
 *
 * @param response - The parsed answer of `GetCrawlStats`.
 * @param end - The last day to consider, as `YYYY-MM-DD`.
 * @returns The day and its `InIndex`, or undefined when Bing reported no day up to `end`.
 */
export function bingIndexed(
  response: unknown,
  end: string,
): { day: string; inIndex: number } | undefined {
  let latest: { day: string; inIndex: number } | undefined;
  for (const row of list(get(response, "d"))) {
    const day = bingDay(get(row, "Date"));
    if (day !== undefined && day <= end && (latest === undefined || day > latest.day)) {
      latest = { day, inIndex: num(get(row, "InIndex")) };
    }
  }
  return latest;
}

/** A query or page with its traffic. */
export interface Row extends Traffic {
  key: string;
  position: number;
}

/**
 * The rows of a Search Analytics answer, by impressions.
 *
 * @param response - The parsed answer of `searchAnalytics/query`.
 * @returns Each row's first key, clicks, impressions and average position.
 */
export function analyticsRows(response: unknown): Row[] {
  return list(get(response, "rows"))
    .map((row) => ({
      key: str(list(get(row, "keys"))[0]),
      clicks: num(get(row, "clicks")),
      impressions: num(get(row, "impressions")),
      position: num(get(row, "position")),
    }))
    .toSorted((a, b) => b.impressions - a.impressions);
}

/**
 * Bing's top queries, by impressions. `GetQueryStats` covers recent weeks, not a chosen month.
 *
 * @param response - The parsed answer of `GetQueryStats`.
 * @returns Each query's clicks, impressions and average impression position.
 */
export function bingQueries(response: unknown): Row[] {
  return list(get(response, "d"))
    .map((row) => ({
      key: str(get(row, "Query")),
      clicks: num(get(row, "Clicks")),
      impressions: num(get(row, "Impressions")),
      position: num(get(row, "AvgImpressionPosition")),
    }))
    .toSorted((a, b) => b.impressions - a.impressions);
}

/**
 * Counts URL Inspection results by coverage state, such as "Submitted and indexed" or "URL is
 * unknown to Google".
 *
 * @param states - The coverage state of each URL.
 * @returns Each state and its count, the most common first.
 */
export function tally(states: readonly string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const state of states) {
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  return [...counts].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** The coverage state Google gives an indexed page. */
export const INDEXED = "Submitted and indexed";

/** The coverage state of a page Google fetched and chose not to index yet. */
export const CRAWLED_NOT_INDEXED = "Crawled - currently not indexed";

/** The coverage state of a page Google has not discovered. */
export const UNKNOWN = "URL is unknown to Google";

/**
 * The days from one day to another.
 *
 * @param from - The earlier day, as `YYYY-MM-DD`.
 * @param to - The later day, as `YYYY-MM-DD`.
 * @returns Whole days, negative when `to` comes first.
 */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** The short name of a package in the row: `core` for hardhat-kms, the provider otherwise. */
export function shortName(name: string): string {
  return name === "hardhat-kms" ? "core" : name.replace(/^@hardhat-kms\//, "");
}

/** One month of a package's downloads. */
export interface DownloadStats {
  total: number;
  /** The median day, which release days do not move. */
  median: number;
  busiest: { day: string; downloads: number } | undefined;
}

/**
 * Reads a month of daily downloads.
 *
 * @param response - The parsed answer of `downloads/range/<start>:<end>/<package>`.
 * @returns The total, the median day and the busiest day.
 */
export function downloadStats(response: unknown): DownloadStats {
  const days = list(get(response, "downloads")).map((row) => ({
    day: str(get(row, "day")),
    downloads: num(get(row, "downloads")),
  }));
  const counts = days.map((day) => day.downloads).toSorted((a, b) => a - b);
  const middle = Math.floor(counts.length / 2);
  const median =
    counts.length === 0
      ? 0
      : counts.length % 2 === 1
        ? (counts[middle] ?? 0)
        : ((counts[middle - 1] ?? 0) + (counts[middle] ?? 0)) / 2;
  const busiest = days.reduce<DownloadStats["busiest"]>(
    (best, day) => (best === undefined || day.downloads > best.downloads ? day : best),
    undefined,
  );
  return { total: counts.reduce((sum, count) => sum + count, 0), median, busiest };
}

/**
 * The days in a month on which a package published a version.
 *
 * @param registry - The parsed registry document of the package.
 * @param range - The month.
 * @returns Each day once, in order.
 */
export function publishDays(registry: unknown, range: MonthRange): string[] {
  const time = get(registry, "time");
  if (typeof time !== "object" || time === null) {
    return [];
  }
  const days = Object.keys(time)
    .filter((version) => version !== "created" && version !== "modified")
    .map((version) => str(get(time, version)).slice(0, 10))
    .filter((day) => day >= range.start && day <= range.end);
  return [...new Set(days)].toSorted();
}

/**
 * The version on `latest` and when it was published.
 *
 * @param registry - The parsed registry document of the package.
 * @returns The version and its publish time, or undefined when the document has neither.
 */
export function latestRelease(
  registry: unknown,
): { version: string; published: string } | undefined {
  const version = str(get(get(registry, "dist-tags"), "latest"));
  const published = str(get(get(registry, "time"), version));
  return version === "" || published === "" ? undefined : { version, published };
}

/**
 * The 1-based position of each package in an npm search.
 *
 * @param response - The parsed answer of `/-/v1/search`.
 * @returns Each listed package's position.
 */
export function searchPositions(response: unknown): Map<string, number> {
  const names = list(get(response, "objects")).map((item) =>
    str(get(get(item, "package"), "name")),
  );
  return new Map(names.map((name, index) => [name, index + 1]));
}

/**
 * The row's text for one npm search.
 *
 * @param query - The search.
 * @param positions - The positions the search returned.
 * @param size - How many results the search asked for.
 * @returns Such as `"hardhat kms": aws 1, gcp 2, core 3`.
 */
export function formatPositions(
  query: string,
  positions: Map<string, number>,
  size: number,
): string {
  const ours = PACKAGES.flatMap((name) => {
    const position = positions.get(name);
    return position === undefined ? [] : [{ name: shortName(name), position }];
  }).toSorted((a, b) => a.position - b.position);
  return ours.length === 0
    ? `"${query}": none in the first ${size}`
    : `"${query}": ${ours.map((item) => `${item.name} ${item.position}`).join(", ")}`;
}

/** One day of GitHub traffic. */
export interface TrafficDay {
  views: number;
  viewUniques: number;
  clones: number;
  cloneUniques: number;
}

/** A referrer or a path with its 14-day counts. */
export interface Popular {
  name: string;
  count: number;
  uniques: number;
}

/** The 14-day referrers and popular paths as read on one day. */
export interface TrafficSnapshot {
  date: string;
  referrers: Popular[];
  paths: Popular[];
}

/** What --traffic-log keeps. */
export interface TrafficLog {
  days: Record<string, TrafficDay>;
  snapshots: TrafficSnapshot[];
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function popularList(value: unknown, key: string): Popular[] {
  return list(value).map((item) => ({
    name: str(get(item, key)),
    count: num(get(item, "count")),
    uniques: num(get(item, "uniques")),
  }));
}

/**
 * Reads a traffic log.
 *
 * @param json - The file's text.
 * @returns The log.
 */
export function parseTrafficLog(json: string): TrafficLog {
  const parsed: unknown = JSON.parse(json);
  const rawDays = get(parsed, "days");
  const rawSnapshots = get(parsed, "snapshots");
  if (typeof rawDays !== "object" || rawDays === null || !Array.isArray(rawSnapshots)) {
    throw new Error("the traffic log is not an object with days and snapshots");
  }
  const days: Record<string, TrafficDay> = {};
  for (const day of Object.keys(rawDays)) {
    if (!DAY.test(day)) {
      throw new Error(`the traffic log has a day "${day}" that is not YYYY-MM-DD`);
    }
    const value = get(rawDays, day);
    days[day] = {
      views: num(get(value, "views")),
      viewUniques: num(get(value, "viewUniques")),
      clones: num(get(value, "clones")),
      cloneUniques: num(get(value, "cloneUniques")),
    };
  }
  const snapshots = list(rawSnapshots).map((snapshot) => {
    const date = str(get(snapshot, "date"));
    if (!DAY.test(date)) {
      throw new Error(`the traffic log has a snapshot dated "${date}", not YYYY-MM-DD`);
    }
    return {
      date,
      referrers: popularList(get(snapshot, "referrers"), "name"),
      paths: popularList(get(snapshot, "paths"), "name"),
    };
  });
  return { days, snapshots };
}

/**
 * Reads GitHub's daily views and clones.
 *
 * @param views - The parsed answer of `traffic/views`.
 * @param clones - The parsed answer of `traffic/clones`.
 * @returns Each day GitHub reported.
 */
export function trafficDays(views: unknown, clones: unknown): Record<string, TrafficDay> {
  const days: Record<string, TrafficDay> = {};
  const day = (key: string): TrafficDay => {
    days[key] ??= { views: 0, viewUniques: 0, clones: 0, cloneUniques: 0 };
    return days[key];
  };
  for (const row of list(get(views, "views"))) {
    const entry = day(str(get(row, "timestamp")).slice(0, 10));
    entry.views = num(get(row, "count"));
    entry.viewUniques = num(get(row, "uniques"));
  }
  for (const row of list(get(clones, "clones"))) {
    const entry = day(str(get(row, "timestamp")).slice(0, 10));
    entry.clones = num(get(row, "count"));
    entry.cloneUniques = num(get(row, "uniques"));
  }
  return days;
}

/**
 * Reads GitHub's 14-day referrers and popular paths.
 *
 * @param date - The day they were read.
 * @param referrers - The parsed answer of `traffic/popular/referrers`.
 * @param paths - The parsed answer of `traffic/popular/paths`.
 * @returns The snapshot.
 */
export function trafficSnapshot(date: string, referrers: unknown, paths: unknown): TrafficSnapshot {
  return {
    date,
    referrers: popularList(referrers, "referrer"),
    paths: popularList(paths, "path"),
  };
}

/**
 * Merges what GitHub reports today into the log. GitHub's numbers for a day replace the logged
 * ones, since a day read while it was still running is counted again later; a snapshot replaces the
 * one of the same date.
 *
 * @param log - The log so far.
 * @param days - The days GitHub reports today.
 * @param snapshot - Today's referrers and paths.
 * @returns The new log, its days and snapshots in order.
 */
export function mergeTraffic(
  log: TrafficLog,
  days: Record<string, TrafficDay>,
  snapshot: TrafficSnapshot,
): TrafficLog {
  const merged = { ...log.days, ...days };
  return {
    days: Object.fromEntries(Object.entries(merged).toSorted(([a], [b]) => a.localeCompare(b))),
    snapshots: [...log.snapshots.filter((old) => old.date !== snapshot.date), snapshot].toSorted(
      (a, b) => a.date.localeCompare(b.date),
    ),
  };
}

/**
 * A month's views and clones from the log.
 *
 * @param log - The log.
 * @param range - The month.
 * @returns The sums and how many of the month's days the log holds.
 */
export function monthTraffic(
  log: TrafficLog,
  range: MonthRange,
): { views: number; clones: number; covered: number; daysInMonth: number } {
  const total = {
    views: 0,
    clones: 0,
    covered: 0,
    daysInMonth: daysBetween(range.start, range.end) + 1,
  };
  for (const [day, value] of Object.entries(log.days)) {
    if (day >= range.start && day <= range.end) {
      total.views += value.views;
      total.clones += value.clones;
      total.covered += 1;
    }
  }
  return total;
}

/**
 * The row's text for referrers: the top three with their counts and the window they cover.
 *
 * @param snapshot - The snapshot to show.
 * @returns Such as `github.com 4 (2 unique), Google 3 (2 unique), the 14 days to 2026-11-11`.
 */
export function formatReferrers(snapshot: TrafficSnapshot): string {
  const top = snapshot.referrers
    .slice(0, 3)
    .map((item) => `${item.name} ${item.count} (${item.uniques} unique)`);
  return `${top.length === 0 ? "none" : top.join(", ")}, the ${TRAFFIC_DAYS} days to ${snapshot.date}`;
}

/** What the sources reported, for {@link findProblems}. */
export interface Facts {
  month: MonthRange;
  sitemapUrls: number;
  /** Sitemap URLs that did not answer 200, with what they answered. */
  brokenUrls: readonly string[];
  google?: {
    /** The last read of each submitted sitemap, undefined for never. */
    sitemapsLastRead: readonly (string | undefined)[];
    indexed?: number;
    crawledNotIndexed: readonly string[];
  };
  bing?: {
    inIndex?: number;
    /** The day of `inIndex`: Bing's daily stats run about a week behind. */
    inIndexDay?: string;
    /** How many sitemap URLs Bing has crawled, from its per-URL information, which is current. */
    crawled?: number;
    sitemaps: readonly { url: string; status: string; lastRead?: string }[];
  };
  context7?: { lastUpdate?: string };
  latest?: { version: string; published: string };
  downloads: readonly { name: string; total: number }[];
  traffic: {
    logged: boolean;
    /** The log's latest snapshot before this run. */
    previousSnapshot?: string;
    covered?: number;
    daysInMonth?: number;
  };
}

/**
 * Lists what looks wrong.
 *
 * @param facts - What the sources reported.
 * @param today - The day of the run, as `YYYY-MM-DD`.
 * @returns One sentence per problem, empty when none.
 */
export function findProblems(facts: Facts, today: string): string[] {
  const problems: string[] = [];
  if (facts.brokenUrls.length > 0) {
    problems.push(
      `${facts.brokenUrls.length} sitemap URLs do not answer 200: ${facts.brokenUrls.join(", ")}`,
    );
  }
  if (facts.google !== undefined) {
    const { sitemapsLastRead, indexed, crawledNotIndexed } = facts.google;
    const reads = sitemapsLastRead.flatMap((read) =>
      read === undefined ? [] : [read.slice(0, 10)],
    );
    if (sitemapsLastRead.length === 0) {
      problems.push("No sitemap is submitted to Google.");
    } else if (reads.length === 0) {
      problems.push(
        "Google has never read the sitemap; request indexing by hand for the pages it does not know.",
      );
    } else {
      const last = reads.toSorted().at(-1) ?? "";
      if (daysBetween(last, today) > SITEMAP_STALE_DAYS.google) {
        problems.push(`Google last read the sitemap on ${last}.`);
      }
    }
    if (indexed !== undefined && indexed < facts.sitemapUrls) {
      problems.push(`Google indexes ${indexed} of the ${facts.sitemapUrls} sitemap URLs.`);
    }
    if (crawledNotIndexed.length > 0) {
      problems.push(
        `Google crawled but did not index ${crawledNotIndexed.join(", ")}; another request does not help, a link from an indexed page or more content may.`,
      );
    }
  }
  if (facts.bing !== undefined) {
    const { inIndex, inIndexDay, crawled, sitemaps } = facts.bing;
    if (sitemaps.length === 0) {
      problems.push("No sitemap is submitted to Bing.");
    }
    for (const sitemap of sitemaps) {
      if (sitemap.lastRead === undefined) {
        problems.push(`Bing has never read ${sitemap.url} (${sitemap.status}).`);
      } else if (daysBetween(sitemap.lastRead, today) > SITEMAP_STALE_DAYS.bing) {
        problems.push(`Bing last read ${sitemap.url} on ${sitemap.lastRead} (${sitemap.status}).`);
      }
    }
    if (crawled !== undefined && crawled < facts.sitemapUrls) {
      problems.push(`Bing has crawled ${crawled} of the ${facts.sitemapUrls} sitemap URLs.`);
    }
    if (inIndex !== undefined && inIndex * 2 < facts.sitemapUrls) {
      const asOf = inIndexDay === undefined ? "" : ` as of ${inIndexDay}`;
      const read = sitemaps
        .flatMap((sitemap) => (sitemap.lastRead === undefined ? [] : [sitemap.lastRead]))
        .toSorted()
        .at(-1);
      const stale =
        inIndexDay !== undefined && read !== undefined && read > inIndexDay
          ? `, before Bing read the sitemap on ${read}; its daily stats run about a week behind`
          : "";
      problems.push(
        `Bing indexes ${inIndex} of the ${facts.sitemapUrls} sitemap URLs${asOf}${stale}.`,
      );
    }
  }
  const lastUpdate = facts.context7?.lastUpdate;
  if (
    facts.latest !== undefined &&
    lastUpdate !== undefined &&
    lastUpdate < facts.latest.published
  ) {
    problems.push(
      `Context7 was last updated on ${lastUpdate.slice(0, 10)}, before ${facts.latest.version} (${facts.latest.published.slice(0, 10)}); run with --refresh-context7.`,
    );
  }
  for (const { name, total } of facts.downloads) {
    if (total === 0) {
      problems.push(`${name} had no downloads in ${facts.month.start.slice(0, 7)}.`);
    }
  }
  const { traffic } = facts;
  if (!traffic.logged) {
    problems.push(
      `GitHub traffic is not logged; GitHub keeps ${TRAFFIC_DAYS} days, so run with --traffic-log every week.`,
    );
  } else {
    if (
      traffic.previousSnapshot !== undefined &&
      daysBetween(traffic.previousSnapshot, today) > TRAFFIC_DAYS
    ) {
      problems.push(
        `The traffic log's previous run was on ${traffic.previousSnapshot}, more than ${TRAFFIC_DAYS} days ago; the days in between are lost.`,
      );
    }
    if (
      traffic.covered !== undefined &&
      traffic.daysInMonth !== undefined &&
      facts.month.end < today &&
      traffic.covered < traffic.daysInMonth
    ) {
      problems.push(
        `The traffic log holds ${traffic.covered} of the ${traffic.daysInMonth} days of ${facts.month.start.slice(0, 7)}.`,
      );
    }
  }
  return problems;
}

/** The cells of the monthly row, in the table's order. */
export interface RowCells {
  month: string;
  downloads: readonly number[];
  stars: string;
  referrers: string;
  npmPositions: string;
  indexed: string;
  impressions: string;
}

/**
 * The month's row for the table on the adoption page, with an empty Notes cell.
 *
 * @param cells - The cells.
 * @returns The Markdown row.
 */
export function monthlyRow(cells: RowCells): string {
  return `| ${[
    cells.month,
    cells.downloads.join(", "),
    cells.stars,
    cells.referrers,
    cells.npmPositions,
    cells.indexed,
    cells.impressions,
    "",
  ].join(" | ")} |`;
}

function formatRows(rows: readonly Row[]): string {
  if (rows.length === 0) {
    return "  none\n";
  }
  return rows
    .slice(0, TOP)
    .map(
      (row) =>
        `  ${row.key}: ${row.impressions} impressions, ${row.clicks} clicks, position ${row.position.toFixed(1)}\n`,
    )
    .join("");
}

function write(text: string): void {
  process.stdout.write(text);
}

const sleep = async (ms: number): Promise<void> =>
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Tries of a request that answers 429, and the pause before the next when it gives no Retry-After. */
const RATE_LIMIT_TRIES = 4;
const RATE_LIMIT_PAUSE_MS = 10_000;

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  let response = await fetch(url, init);
  for (let attempt = 1; response.status === 429 && attempt < RATE_LIMIT_TRIES; attempt += 1) {
    const retryAfter = Number(response.headers.get("retry-after"));
    await response.body?.cancel();
    await sleep(
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter, 120) * 1000
        : RATE_LIMIT_PAUSE_MS * attempt,
    );
    response = await fetch(url, init);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `${init?.method ?? "GET"} ${redactKey(url)} answered ${response.status}: ${redactKey(text.slice(0, 300))}`,
    );
  }
  return text === "" ? undefined : JSON.parse(text);
}

/** An environment variable, or undefined when it is unset or empty. */
function env(variable: string): string | undefined {
  // oxlint-disable-next-line node/no-process-env -- the credentials come from the environment, never from a file in the repository
  const value = process.env[variable];
  return value === "" ? undefined : value;
}

/** A secret from the environment, or on macOS from the login Keychain. */
function secret(variable: string, keychainItem: string): string | undefined {
  const fromEnv = env(variable);
  if (fromEnv !== undefined) {
    return fromEnv;
  }
  if (process.platform !== "darwin") {
    return undefined;
  }
  try {
    const value = execFileSync("security", ["find-generic-password", "-s", keychainItem, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}

async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  // The workers share one iterator, so each item is taken once.
  const queue = items.entries();
  const worker = async (): Promise<void> => {
    for (const [index, item] of queue) {
      results[index] = await run(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** The URLs that do not answer 200 to a HEAD, with what they answered. */
async function brokenUrls(urls: readonly string[]): Promise<string[]> {
  const answers = await mapLimited(urls, URL_CHECK_CONCURRENCY, async (url) => {
    try {
      const response = await fetch(url, { method: "HEAD", redirect: "manual" });
      return response.status === 200 ? undefined : `${url} (${response.status})`;
    } catch (error: unknown) {
      return `${url} (${error instanceof Error ? error.message : String(error)})`;
    }
  });
  return answers.filter((answer) => answer !== undefined);
}

interface NpmResult {
  downloads: { name: string; total: number }[];
  positions: string;
  latest: { version: string; published: string } | undefined;
}

async function npm(range: MonthRange): Promise<NpmResult> {
  write("\n== npm\n");
  const downloads: { name: string; total: number }[] = [];
  let latest: NpmResult["latest"];
  for (const name of PACKAGES) {
    const stats = downloadStats(
      await fetchJson(`${NPM_DOWNLOADS}/range/${range.start}:${range.end}/${name}`),
    );
    const registry = await fetchJson(`${NPM_REGISTRY}/${name.replaceAll("/", "%2f")}`);
    if (name === "hardhat-kms") {
      latest = latestRelease(registry);
    }
    const published = publishDays(registry, range);
    write(
      `  ${name}: ${stats.total} downloads, median day ${stats.median}, busiest ${stats.busiest?.day ?? "none"} (${stats.busiest?.downloads ?? 0}), published on ${published.length === 0 ? "no day" : published.map((day) => day.slice(8)).join(", ")}\n`,
    );
    downloads.push({ name, total: stats.total });
  }
  const size = 20;
  const positions: string[] = [];
  for (const query of NPM_SEARCHES) {
    const answer = await fetchJson(
      `${NPM_REGISTRY}/-/v1/search?text=${encodeURIComponent(query)}&size=${size}`,
    );
    positions.push(formatPositions(query, searchPositions(answer), size));
  }
  write(`  search today: ${positions.join("; ")}\n`);
  if (latest !== undefined) {
    write(`  latest: ${latest.version}, published ${latest.published.slice(0, 10)}\n`);
  }
  return { downloads, positions: positions.join("; "), latest };
}

function ghApi(endpoint: string): unknown {
  return JSON.parse(
    execFileSync("gh", ["api", endpoint], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    }),
  );
}

interface GitHubResult {
  stars: string;
  referrers: string;
  logged: boolean;
  previousSnapshot?: string;
  covered?: number;
  daysInMonth?: number;
}

function github(range: MonthRange, today: string, logFile: string | undefined): GitHubResult {
  write("\n== GitHub\n");
  let repo: unknown;
  try {
    repo = ghApi(`repos/${REPOSITORY}`);
  } catch {
    write("  skipped: gh could not read the repository; run `gh auth login`\n");
    return { stars: "n/a", referrers: "n/a", logged: false };
  }
  const stars = num(get(repo, "stargazers_count"));
  write(
    `  ${stars} stars, ${num(get(repo, "forks_count"))} forks, ${num(get(repo, "subscribers_count"))} watchers\n`,
  );
  const views = ghApi(`repos/${REPOSITORY}/traffic/views`);
  const clones = ghApi(`repos/${REPOSITORY}/traffic/clones`);
  const snapshot = trafficSnapshot(
    today,
    ghApi(`repos/${REPOSITORY}/traffic/popular/referrers`),
    ghApi(`repos/${REPOSITORY}/traffic/popular/paths`),
  );
  write(
    `  last ${TRAFFIC_DAYS} days: ${num(get(views, "count"))} views (${num(get(views, "uniques"))} unique), ${num(get(clones, "count"))} clones (${num(get(clones, "uniques"))} unique)\n`,
  );
  write(`  referrers: ${formatReferrers(snapshot)}\n`);
  write("  popular paths:\n");
  for (const item of snapshot.paths.slice(0, 5)) {
    write(`    ${item.name} ${item.count} (${item.uniques} unique)\n`);
  }
  const result: GitHubResult = {
    stars: String(stars),
    referrers: formatReferrers(snapshot),
    logged: logFile !== undefined,
  };
  if (logFile === undefined) {
    return result;
  }
  const log = existsSync(logFile)
    ? parseTrafficLog(readFileSync(logFile, "utf8"))
    : { days: {}, snapshots: [] };
  const previousSnapshot = log.snapshots.at(-1)?.date;
  const merged = mergeTraffic(log, trafficDays(views, clones), snapshot);
  writeFileSync(logFile, `${JSON.stringify(merged, null, 2)}\n`);
  const month = monthTraffic(merged, range);
  write(
    `  log ${logFile}: ${Object.keys(merged.days).length} days, ${merged.snapshots.length} snapshots; ${range.start.slice(0, 7)}: ${month.views} views, ${month.clones} clones over ${month.covered} of ${month.daysInMonth} days\n`,
  );
  return {
    ...result,
    ...(previousSnapshot === undefined ? {} : { previousSnapshot }),
    covered: month.covered,
    daysInMonth: month.daysInMonth,
  };
}

interface GoogleResult {
  impressions: number;
  clicks: number;
  sitemapsLastRead: (string | undefined)[];
  indexed?: number;
  crawledNotIndexed: string[];
}

async function google(
  range: MonthRange,
  urls: readonly string[],
  inspect: boolean,
): Promise<GoogleResult | undefined> {
  const account = env("ADOPTION_GSC_SERVICE_ACCOUNT");
  write("\n== Google Search Console\n");
  if (account === undefined) {
    write("  skipped: ADOPTION_GSC_SERVICE_ACCOUNT is not set\n");
    return undefined;
  }
  const token = execFileSync(
    "gcloud",
    [
      "auth",
      "print-access-token",
      `--impersonate-service-account=${account}`,
      "--scopes=https://www.googleapis.com/auth/webmasters.readonly",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const site = encodeURIComponent(SITE);
  const query = async (body: object): Promise<unknown> =>
    await fetchJson(`${GSC}/webmasters/v3/sites/${site}/searchAnalytics/query`, {
      method: "POST",
      headers,
      body: JSON.stringify({ startDate: range.start, endDate: range.end, ...body }),
    });

  const [total] = analyticsRows(await query({}));
  const result: GoogleResult = {
    impressions: total?.impressions ?? 0,
    clicks: total?.clicks ?? 0,
    sitemapsLastRead: [],
    crawledNotIndexed: [],
  };
  write(
    `  ${range.start} to ${range.end}: ${result.impressions} impressions, ${result.clicks} clicks\n`,
  );
  write("  top queries:\n");
  write(formatRows(analyticsRows(await query({ dimensions: ["query"], rowLimit: TOP }))));
  write("  top pages:\n");
  write(formatRows(analyticsRows(await query({ dimensions: ["page"], rowLimit: TOP }))));

  const sitemaps = list(
    get(await fetchJson(`${GSC}/webmasters/v3/sites/${site}/sitemaps`, { headers }), "sitemap"),
  );
  for (const sitemap of sitemaps) {
    const read = get(sitemap, "lastDownloaded");
    result.sitemapsLastRead.push(typeof read === "string" ? read : undefined);
    write(`  sitemap ${str(get(sitemap, "path"))}: last read ${str(read, "never")}\n`);
  }
  if (sitemaps.length === 0) {
    write("  no sitemap submitted\n");
  }

  if (!inspect) {
    return result;
  }
  const states = await mapLimited(urls, INSPECTION_CONCURRENCY, async (url) => {
    const answer = await fetchJson(`${GSC}/v1/urlInspection/index:inspect`, {
      method: "POST",
      headers,
      body: JSON.stringify({ inspectionUrl: url, siteUrl: SITE }),
    });
    return str(
      get(get(get(answer, "inspectionResult"), "indexStatusResult"), "coverageState"),
      "no answer",
    );
  });
  result.indexed = states.filter((state) => state === INDEXED).length;
  result.crawledNotIndexed = urls.filter((_, index) => states[index] === CRAWLED_NOT_INDEXED);
  write(`  indexed: ${result.indexed} / ${urls.length} sitemap URLs (read today)\n`);
  for (const [state, count] of tally(states)) {
    write(`    ${count} ${state}\n`);
  }
  const unknown = urls.filter((_, index) => states[index] === UNKNOWN);
  if (unknown.length > 0) {
    write("  unknown to Google, to request by hand:\n");
    for (const url of unknown) {
      write(`    ${url}\n`);
    }
  }
  return result;
}

interface BingResult {
  impressions: number;
  inIndex?: number;
  inIndexDay?: string;
  crawled?: number;
  sitemaps: { url: string; status: string; lastRead?: string }[];
}

/** The pause between Bing's per-URL calls, and after a throttled one, which Bing answers with ThrottleHost. */
const BING_URL_PAUSE_MS = 2000;
const BING_THROTTLE_PAUSE_MS = 5000;
const BING_URL_TRIES = 6;

/** When Bing last crawled each URL, one call at a time; undefined when Bing kept throttling. */
async function bingCrawlDays(
  urls: readonly string[],
  key: string,
): Promise<(string | undefined)[] | undefined> {
  const days: (string | undefined)[] = [];
  for (const url of urls) {
    const request = `${BING}/GetUrlInfo?siteUrl=${encodeURIComponent(SITE)}&url=${encodeURIComponent(url)}&apikey=${encodeURIComponent(key)}`;
    let answer: unknown;
    for (let attempt = 1; answer === undefined; attempt += 1) {
      try {
        answer = await fetchJson(request);
      } catch (error: unknown) {
        if (!String(error).includes("ThrottleHost") || attempt === BING_URL_TRIES) {
          return undefined;
        }
        await sleep(BING_THROTTLE_PAUSE_MS * attempt);
      }
    }
    days.push(bingLastCrawled(answer));
    await sleep(BING_URL_PAUSE_MS);
  }
  return days;
}

async function bing(range: MonthRange, urls: readonly string[]): Promise<BingResult | undefined> {
  write("\n== Bing Webmaster Tools\n");
  const key = secret("BING_WEBMASTER_API_KEY", "bing-webmaster-api");
  if (key === undefined) {
    write("  skipped: no BING_WEBMASTER_API_KEY and no bing-webmaster-api Keychain item\n");
    return undefined;
  }
  const call = async (method: string): Promise<unknown> =>
    await fetchJson(
      `${BING}/${method}?siteUrl=${encodeURIComponent(SITE)}&apikey=${encodeURIComponent(key)}`,
    );
  const traffic = bingMonthTraffic(await call("GetRankAndTrafficStats"), range);
  write(
    `  ${range.start} to ${range.end}: ${traffic.impressions} impressions, ${traffic.clicks} clicks (${traffic.days} days reported)\n`,
  );
  write("  top queries (recent weeks):\n");
  write(formatRows(bingQueries(await call("GetQueryStats"))));
  const indexed = bingIndexed(await call("GetCrawlStats"), range.end);
  write(
    indexed === undefined
      ? "  indexed: no crawl data up to the end of the month\n"
      : `  indexed: ${indexed.inIndex} pages on ${indexed.day} (the daily stats run about a week behind)\n`,
  );
  const crawledDays = await bingCrawlDays(urls, key);
  const crawled = crawledDays?.filter((day) => day !== undefined).length;
  write(
    crawled === undefined
      ? "  crawled: not read, Bing throttled the per-URL calls\n"
      : `  crawled: ${crawled} / ${urls.length} sitemap URLs (per URL, read today)\n`,
  );
  const sitemaps = list(get(await call("GetFeeds"), "d")).map((feed) => {
    const lastRead = bingDay(get(feed, "LastCrawled"));
    return {
      url: str(get(feed, "Url")),
      status: str(get(feed, "Status"), "no status"),
      urlCount: num(get(feed, "UrlCount")),
      ...(lastRead === undefined ? {} : { lastRead }),
    };
  });
  for (const sitemap of sitemaps) {
    write(
      `  sitemap ${sitemap.url}: ${sitemap.status}, ${sitemap.urlCount} URLs, last read ${sitemap.lastRead ?? "never"}\n`,
    );
  }
  if (sitemaps.length === 0) {
    write("  no sitemap submitted\n");
  }
  return {
    impressions: traffic.impressions,
    ...(indexed === undefined ? {} : { inIndex: indexed.inIndex, inIndexDay: indexed.day }),
    ...(crawled === undefined ? {} : { crawled }),
    sitemaps,
  };
}

async function context7(refresh: boolean): Promise<{ lastUpdate?: string }> {
  write("\n== Context7\n");
  const search = await fetchJson(`${CONTEXT7}/search?query=hardhat-kms`);
  const library = list(get(search, "results")).find(
    (result) => get(result, "id") === CONTEXT7_LIBRARY,
  );
  const lastUpdate = str(get(library, "lastUpdateDate"));
  write(
    library === undefined
      ? `  ${CONTEXT7_LIBRARY} is not listed\n`
      : `  ${CONTEXT7_LIBRARY}: ${str(get(library, "state"), "no state")}, last updated ${lastUpdate === "" ? "never" : lastUpdate}, ${num(get(library, "totalSnippets"))} snippets\n`,
  );
  if (refresh) {
    const key = secret("CONTEXT7_API_KEY", "context7-api");
    if (key === undefined) {
      throw new Error("--refresh-context7 needs CONTEXT7_API_KEY or a context7-api Keychain item");
    }
    const answer = await fetchJson(`${CONTEXT7}/refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ libraryName: CONTEXT7_LIBRARY }),
    });
    write(`  refresh: ${str(get(answer, "message"), "started")}\n`);
    // A refresh is under way, so the date before it is not a problem.
    return {};
  }
  return lastUpdate === "" ? {} : { lastUpdate };
}

async function main(argv: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      month: { type: "string" },
      "traffic-log": { type: "string" },
      "refresh-context7": { type: "boolean" },
      "skip-inspection": { type: "boolean" },
    },
    strict: true,
  });
  if (values.month === undefined) {
    throw new Error("--month is required: the month the entry covers, such as 2026-10");
  }
  const range = monthRange(values.month);
  const today = new Date().toISOString().slice(0, 10);
  const sitemap = await fetch(`${SITE}sitemap.xml`);
  if (!sitemap.ok) {
    throw new Error(`${SITE}sitemap.xml answered ${sitemap.status}`);
  }
  const urls = sitemapUrls(await sitemap.text());
  const broken = await brokenUrls(urls);
  write(
    `${SITE}sitemap.xml lists ${urls.length} pages today, ${urls.length - broken.length} answer 200\n`,
  );

  const npmResult = await npm(range);
  const githubResult = github(range, today, values["traffic-log"]);
  const googleResult = await google(range, urls, values["skip-inspection"] !== true);
  const bingResult = await bing(range, urls);
  const context7Result = await context7(values["refresh-context7"] === true);

  const problems = findProblems(
    {
      month: range,
      sitemapUrls: urls.length,
      brokenUrls: broken,
      ...(googleResult === undefined ? {} : { google: googleResult }),
      ...(bingResult === undefined ? {} : { bing: bingResult }),
      context7: context7Result,
      ...(npmResult.latest === undefined ? {} : { latest: npmResult.latest }),
      downloads: npmResult.downloads,
      traffic: githubResult,
    },
    today,
  );
  write("\n== Problems\n");
  write(
    problems.length === 0 ? "  none\n" : problems.map((problem) => `  - ${problem}\n`).join(""),
  );

  const indexed = (count: number | undefined): string =>
    count === undefined ? "n/a" : `${count} / ${urls.length}`;
  write("\n== Row (add the notes)\n");
  write(
    `${monthlyRow({
      month: values.month,
      downloads: npmResult.downloads.map((item) => item.total),
      stars: githubResult.stars,
      referrers: githubResult.referrers,
      npmPositions: npmResult.positions,
      indexed: `Google ${indexed(googleResult?.indexed)}, Bing ${indexed(bingResult?.inIndex)}, read on ${today}`,
      impressions:
        googleResult === undefined ? "n/a" : `${googleResult.impressions}, ${googleResult.clicks}`,
    })}\n`,
  );
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error: unknown) {
    process.stderr.write(`${redactKey(error instanceof Error ? error.message : String(error))}\n`);
    process.exitCode = 1;
  }
}
