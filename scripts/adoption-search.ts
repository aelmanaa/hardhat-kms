// The search part of the monthly adoption check (docs/contributor/adoption-metrics.md, #690): reads
// Google Search Console and Bing Webmaster Tools for one month, and Context7's index state, through
// their APIs. It only reads, apart from the Context7 refresh that --refresh-context7 asks for.
//
//   node scripts/adoption-search.ts --month 2026-10 [--refresh-context7] [--skip-inspection]
//
// Google: a read-only service account that the maintainer impersonates with gcloud, named by
// ADOPTION_GSC_SERVICE_ACCOUNT, so no key file exists. Bing and Context7: an API key from
// BING_WEBMASTER_API_KEY and CONTEXT7_API_KEY, or on macOS from the login Keychain items
// bing-webmaster-api and context7-api. A source without credentials is skipped. No key is printed:
// Bing takes its key in the query string, so every error names the URL with the key redacted.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

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
  return url.replace(/([?&]apikey=)[^&]*/gi, "$1<redacted>");
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
 * The day of a Bing date, which the JSON API writes as `/Date(<ms>)/` or `/Date(<ms>-0700)/`.
 *
 * @param value - The date as Bing wrote it.
 * @returns The UTC day as `YYYY-MM-DD`, or undefined for anything else.
 */
export function bingDay(value: unknown): string | undefined {
  const match = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(str(value));
  return match === null ? undefined : new Date(Number(match[1])).toISOString().slice(0, 10);
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

/** The page counts as "indexed", the one coverage state Google gives an indexed page. */
export const INDEXED = "Submitted and indexed";

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

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
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

async function google(range: MonthRange, urls: readonly string[], inspect: boolean): Promise<void> {
  const account = env("ADOPTION_GSC_SERVICE_ACCOUNT");
  process.stdout.write("\n== Google Search Console\n");
  if (account === undefined) {
    process.stdout.write("  skipped: ADOPTION_GSC_SERVICE_ACCOUNT is not set\n");
    return;
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
  process.stdout.write(
    `  ${range.start} to ${range.end}: ${total?.impressions ?? 0} impressions, ${total?.clicks ?? 0} clicks\n`,
  );
  process.stdout.write("  top queries:\n");
  process.stdout.write(
    formatRows(analyticsRows(await query({ dimensions: ["query"], rowLimit: TOP }))),
  );
  process.stdout.write("  top pages:\n");
  process.stdout.write(
    formatRows(analyticsRows(await query({ dimensions: ["page"], rowLimit: TOP }))),
  );

  const sitemaps = list(
    get(await fetchJson(`${GSC}/webmasters/v3/sites/${site}/sitemaps`, { headers }), "sitemap"),
  );
  for (const sitemap of sitemaps) {
    process.stdout.write(
      `  sitemap ${str(get(sitemap, "path"))}: last read ${str(get(sitemap, "lastDownloaded"), "never")}\n`,
    );
  }
  if (sitemaps.length === 0) {
    process.stdout.write("  no sitemap submitted\n");
  }

  if (!inspect) {
    return;
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
  const indexed = states.filter((state) => state === INDEXED).length;
  process.stdout.write(`  indexed: ${indexed} / ${urls.length} sitemap URLs (read today)\n`);
  for (const [state, count] of tally(states)) {
    process.stdout.write(`    ${count} ${state}\n`);
  }
  const missing = urls.filter((_, index) => states[index] !== INDEXED);
  if (missing.length > 0 && missing.length < urls.length) {
    process.stdout.write("  not indexed:\n");
    for (const url of missing) {
      process.stdout.write(`    ${url}\n`);
    }
  }
}

async function bing(range: MonthRange): Promise<void> {
  process.stdout.write("\n== Bing Webmaster Tools\n");
  const key = secret("BING_WEBMASTER_API_KEY", "bing-webmaster-api");
  if (key === undefined) {
    process.stdout.write(
      "  skipped: no BING_WEBMASTER_API_KEY and no bing-webmaster-api Keychain item\n",
    );
    return;
  }
  const call = async (method: string): Promise<unknown> =>
    await fetchJson(
      `${BING}/${method}?siteUrl=${encodeURIComponent(SITE)}&apikey=${encodeURIComponent(key)}`,
    );
  const traffic = bingMonthTraffic(await call("GetRankAndTrafficStats"), range);
  process.stdout.write(
    `  ${range.start} to ${range.end}: ${traffic.impressions} impressions, ${traffic.clicks} clicks (${traffic.days} days reported)\n`,
  );
  process.stdout.write("  top queries (recent weeks):\n");
  process.stdout.write(formatRows(bingQueries(await call("GetQueryStats"))));
  const indexed = bingIndexed(await call("GetCrawlStats"), range.end);
  process.stdout.write(
    indexed === undefined
      ? "  indexed: no crawl data up to the end of the month\n"
      : `  indexed: ${indexed.inIndex} pages on ${indexed.day}\n`,
  );
  const feeds = list(get(await call("GetFeeds"), "d"));
  for (const feed of feeds) {
    process.stdout.write(
      `  sitemap ${str(get(feed, "Url"))}: ${str(get(feed, "Status"), "no status")}, ${num(get(feed, "UrlCount"))} URLs, last read ${bingDay(get(feed, "LastCrawled")) ?? "never"}\n`,
    );
  }
  if (feeds.length === 0) {
    process.stdout.write("  no sitemap submitted\n");
  }
}

async function context7(refresh: boolean): Promise<void> {
  process.stdout.write("\n== Context7\n");
  const search = await fetchJson(`${CONTEXT7}/search?query=hardhat-kms`);
  const library = list(get(search, "results")).find(
    (result) => get(result, "id") === CONTEXT7_LIBRARY,
  );
  process.stdout.write(
    library === undefined
      ? `  ${CONTEXT7_LIBRARY} is not listed\n`
      : `  ${CONTEXT7_LIBRARY}: ${str(get(library, "state"), "no state")}, last updated ${str(get(library, "lastUpdateDate"), "never")}, ${num(get(library, "totalSnippets"))} snippets\n`,
  );
  if (!refresh) {
    return;
  }
  const key = secret("CONTEXT7_API_KEY", "context7-api");
  if (key === undefined) {
    throw new Error("--refresh-context7 needs CONTEXT7_API_KEY or a context7-api Keychain item");
  }
  const answer = await fetchJson(`${CONTEXT7}/refresh`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ libraryName: CONTEXT7_LIBRARY }),
  });
  process.stdout.write(`  refresh: ${str(get(answer, "message"), "started")}\n`);
}

async function main(argv: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      month: { type: "string" },
      "refresh-context7": { type: "boolean" },
      "skip-inspection": { type: "boolean" },
    },
    strict: true,
  });
  if (values.month === undefined) {
    throw new Error("--month is required: the month the entry covers, such as 2026-10");
  }
  const range = monthRange(values.month);
  const sitemap = await fetch(`${SITE}sitemap.xml`);
  if (!sitemap.ok) {
    throw new Error(`${SITE}sitemap.xml answered ${sitemap.status}`);
  }
  const urls = sitemapUrls(await sitemap.text());
  process.stdout.write(`${SITE}sitemap.xml lists ${urls.length} pages today\n`);
  await google(range, urls, values["skip-inspection"] !== true);
  await bing(range);
  await context7(values["refresh-context7"] === true);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error: unknown) {
    process.stderr.write(`${redactKey(error instanceof Error ? error.message : String(error))}\n`);
    process.exitCode = 1;
  }
}
