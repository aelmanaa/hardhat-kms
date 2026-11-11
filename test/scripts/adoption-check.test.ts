// The parsing, traffic log and problems of scripts/adoption-check.ts, fed with answers shaped like
// the ones npm, GitHub, Search Console, Bing Webmaster Tools and the sitemap gave on 2026-11-10 and
// 2026-11-11. Runs in `pnpm test`, with no network.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  analyticsRows,
  bingDay,
  bingIndexed,
  bingMonthTraffic,
  bingQueries,
  daysBetween,
  downloadStats,
  type Facts,
  findProblems,
  formatPositions,
  formatReferrers,
  latestRelease,
  mergeTraffic,
  monthlyRow,
  monthRange,
  monthTraffic,
  parseTrafficLog,
  publishDays,
  redactKey,
  searchPositions,
  shortName,
  sitemapUrls,
  tally,
  trafficDays,
  trafficSnapshot,
} from "../../scripts/adoption-check.ts";

/** A Bing date for a UTC day. */
function bingDate(day: string): string {
  return `/Date(${Date.parse(`${day}T00:00:00Z`)})/`;
}

describe("monthRange", () => {
  it("gives the first and last day, leap years included", () => {
    assert.deepEqual(monthRange("2026-10"), { start: "2026-10-01", end: "2026-10-31" });
    assert.deepEqual(monthRange("2026-11"), { start: "2026-11-01", end: "2026-11-30" });
    assert.deepEqual(monthRange("2028-02"), { start: "2028-02-01", end: "2028-02-29" });
  });

  it("refuses anything but YYYY-MM", () => {
    for (const month of ["2026-13", "2026-1", "october", "2026-10-01"]) {
      assert.throws(() => monthRange(month), { message: /--month must be YYYY-MM/ });
    }
  });
});

describe("sitemapUrls", () => {
  it("lists each loc in order", () => {
    const xml =
      '<?xml version="1.0"?><urlset><url><loc>https://a.example/</loc><lastmod>2026-11-03</lastmod></url>' +
      "<url><loc>\n  https://a.example/b\n</loc></url></urlset>";
    assert.deepEqual(sitemapUrls(xml), ["https://a.example/", "https://a.example/b"]);
    assert.deepEqual(sitemapUrls("<urlset></urlset>"), []);
  });
});

describe("redactKey", () => {
  it("hides the apikey parameter wherever it sits", () => {
    assert.equal(
      redactKey("https://ssl.bing.com/x?siteUrl=s&apikey=abc123&y=1"),
      "https://ssl.bing.com/x?siteUrl=s&apikey=<redacted>&y=1",
    );
    assert.equal(redactKey("https://h/x?APIKEY=abc"), "https://h/x?APIKEY=<redacted>");
    assert.equal(redactKey("https://h/x?siteUrl=s"), "https://h/x?siteUrl=s");
  });
});

describe("bingDay", () => {
  it("reads Bing's date with and without an offset", () => {
    assert.equal(bingDay("/Date(1791676800000)/"), "2026-10-11");
    assert.equal(bingDay("/Date(1791676800000-0700)/"), "2026-10-11");
    assert.equal(bingDay("2026-10-11"), undefined);
    assert.equal(bingDay(undefined), undefined);
  });
});

describe("bingMonthTraffic", () => {
  it("sums the days inside the month only", () => {
    const response = {
      d: [
        { Date: bingDate("2026-09-30"), Clicks: 9, Impressions: 90 },
        { Date: bingDate("2026-10-01"), Clicks: 1, Impressions: 10 },
        { Date: bingDate("2026-10-31"), Clicks: 2, Impressions: 20 },
        { Date: bingDate("2026-11-01"), Clicks: 9, Impressions: 90 },
        { Date: "not a date", Clicks: 9, Impressions: 90 },
      ],
    };
    assert.deepEqual(bingMonthTraffic(response, monthRange("2026-10")), {
      clicks: 3,
      impressions: 30,
      days: 2,
    });
    assert.deepEqual(bingMonthTraffic({}, monthRange("2026-10")), {
      clicks: 0,
      impressions: 0,
      days: 0,
    });
  });
});

describe("bingIndexed", () => {
  it("takes the latest day up to the end of the month", () => {
    const response = {
      d: [
        { Date: bingDate("2026-10-29"), InIndex: 0 },
        { Date: bingDate("2026-10-31"), InIndex: 1 },
        { Date: bingDate("2026-10-30"), InIndex: 1 },
        { Date: bingDate("2026-11-03"), InIndex: 5 },
      ],
    };
    assert.deepEqual(bingIndexed(response, "2026-10-31"), { day: "2026-10-31", inIndex: 1 });
    assert.deepEqual(bingIndexed(response, "2026-11-30"), { day: "2026-11-03", inIndex: 5 });
    assert.equal(bingIndexed(response, "2026-09-30"), undefined);
  });
});

describe("analyticsRows and bingQueries", () => {
  it("read each row and sort by impressions", () => {
    const google = {
      rows: [
        { keys: ["hardhat kms"], clicks: 1, impressions: 3, position: 8.5 },
        { keys: ["site:github.io"], clicks: 0, impressions: 9, position: 276 },
      ],
    };
    assert.deepEqual(analyticsRows(google), [
      { key: "site:github.io", clicks: 0, impressions: 9, position: 276 },
      { key: "hardhat kms", clicks: 1, impressions: 3, position: 8.5 },
    ]);
    assert.deepEqual(analyticsRows({}), []);
    // The totals query has rows with no keys.
    assert.deepEqual(analyticsRows({ rows: [{ clicks: 2, impressions: 12, position: 25.6 }] }), [
      { key: "", clicks: 2, impressions: 12, position: 25.6 },
    ]);

    const bing = {
      d: [{ Query: "hardhat kms", Clicks: 1, Impressions: 4, AvgImpressionPosition: 3.2 }],
    };
    assert.deepEqual(bingQueries(bing), [
      { key: "hardhat kms", clicks: 1, impressions: 4, position: 3.2 },
    ]);
    assert.deepEqual(bingQueries({ d: [] }), []);
  });
});

describe("tally", () => {
  it("counts each state, the most common first", () => {
    assert.deepEqual(
      tally([
        "URL is unknown to Google",
        "Submitted and indexed",
        "URL is unknown to Google",
        "Crawled - currently not indexed",
      ]),
      [
        ["URL is unknown to Google", 2],
        ["Crawled - currently not indexed", 1],
        ["Submitted and indexed", 1],
      ],
    );
  });
});

describe("npm", () => {
  it("reads a month of downloads: total, median day and busiest day", () => {
    const response = {
      downloads: [
        { day: "2026-10-01", downloads: 2 },
        { day: "2026-10-02", downloads: 390 },
        { day: "2026-10-03", downloads: 5 },
        { day: "2026-10-04", downloads: 1 },
      ],
    };
    assert.deepEqual(downloadStats(response), {
      total: 398,
      median: 3.5,
      busiest: { day: "2026-10-02", downloads: 390 },
    });
    assert.deepEqual(downloadStats({ downloads: [{ day: "2026-10-01", downloads: 7 }] }), {
      total: 7,
      median: 7,
      busiest: { day: "2026-10-01", downloads: 7 },
    });
    assert.deepEqual(downloadStats({}), { total: 0, median: 0, busiest: undefined });
  });

  it("finds the publish days in a month and the release on latest", () => {
    const registry = {
      "dist-tags": { latest: "1.5.1", beta: "1.5.1" },
      time: {
        created: "2026-10-07T10:00:00.000Z",
        modified: "2026-11-05T21:30:00.000Z",
        "1.4.0": "2026-10-26T09:00:00.000Z",
        "1.5.0": "2026-11-05T10:42:19.358Z",
        "1.5.1": "2026-11-05T21:23:14.418Z",
      },
    };
    assert.deepEqual(publishDays(registry, monthRange("2026-11")), ["2026-11-05"]);
    assert.deepEqual(publishDays(registry, monthRange("2026-10")), ["2026-10-26"]);
    assert.deepEqual(publishDays({}, monthRange("2026-10")), []);
    assert.deepEqual(latestRelease(registry), {
      version: "1.5.1",
      published: "2026-11-05T21:23:14.418Z",
    });
    assert.equal(latestRelease({ "dist-tags": { latest: "9.9.9" }, time: {} }), undefined);
  });

  it("gives each package's position in a search", () => {
    const answer = {
      objects: [
        { package: { name: "@hardhat-kms/aws" } },
        { package: { name: "@hardhat-kms/gcp" } },
        { package: { name: "hardhat-kms" } },
        { package: { name: "hardhat" } },
      ],
    };
    const positions = searchPositions(answer);
    assert.equal(positions.get("hardhat-kms"), 3);
    assert.equal(
      formatPositions("hardhat kms", positions, 20),
      '"hardhat kms": aws 1, gcp 2, core 3',
    );
    assert.equal(
      formatPositions("hardhat safe", searchPositions({ objects: [] }), 20),
      '"hardhat safe": none in the first 20',
    );
    assert.equal(shortName("hardhat-kms"), "core");
    assert.equal(shortName("@hardhat-kms/turnkey"), "turnkey");
  });
});

describe("the GitHub traffic log", () => {
  const views = {
    count: 3,
    uniques: 2,
    views: [
      { timestamp: "2026-10-30T00:00:00Z", count: 1, uniques: 1 },
      { timestamp: "2026-11-01T00:00:00Z", count: 2, uniques: 1 },
    ],
  };
  const clones = { clones: [{ timestamp: "2026-11-01T00:00:00Z", count: 40, uniques: 9 }] };

  it("reads the days and a snapshot of referrers and paths", () => {
    assert.deepEqual(trafficDays(views, clones), {
      "2026-10-30": { views: 1, viewUniques: 1, clones: 0, cloneUniques: 0 },
      "2026-11-01": { views: 2, viewUniques: 1, clones: 40, cloneUniques: 9 },
    });
    const snapshot = trafficSnapshot(
      "2026-11-11",
      [
        { referrer: "github.com", count: 4, uniques: 2 },
        { referrer: "Google", count: 3, uniques: 2 },
      ],
      [{ path: "/aelmanaa/hardhat-kms", title: "x", count: 5, uniques: 1 }],
    );
    assert.equal(
      formatReferrers(snapshot),
      "github.com 4 (2 unique), Google 3 (2 unique), the 14 days to 2026-11-11",
    );
    assert.deepEqual(snapshot.paths, [{ name: "/aelmanaa/hardhat-kms", count: 5, uniques: 1 }]);
    assert.equal(
      formatReferrers({ date: "2026-11-11", referrers: [], paths: [] }),
      "none, the 14 days to 2026-11-11",
    );
  });

  it("merges a run into the log, newer days and same-day snapshots replacing older ones", () => {
    const first = mergeTraffic(
      { days: {}, snapshots: [] },
      trafficDays(views, clones),
      trafficSnapshot("2026-11-01", [], []),
    );
    const later = mergeTraffic(
      first,
      { "2026-11-01": { views: 5, viewUniques: 3, clones: 41, cloneUniques: 9 } },
      trafficSnapshot("2026-11-01", [{ referrer: "Google", count: 1, uniques: 1 }], []),
    );
    assert.deepEqual(Object.keys(later.days), ["2026-10-30", "2026-11-01"]);
    assert.equal(later.days["2026-11-01"]?.views, 5);
    assert.equal(later.snapshots.length, 1);
    assert.equal(later.snapshots[0]?.referrers[0]?.name, "Google");

    const round = parseTrafficLog(JSON.stringify(later));
    assert.deepEqual(round, later);
    assert.deepEqual(monthTraffic(round, monthRange("2026-11")), {
      views: 5,
      clones: 41,
      covered: 1,
      daysInMonth: 30,
    });
  });

  it("refuses a file that is not a traffic log", () => {
    assert.throws(() => parseTrafficLog("[]"), {
      message: "the traffic log is not an object with days and snapshots",
    });
    assert.throws(() => parseTrafficLog('{"days":{"Nov 1":{}},"snapshots":[]}'), {
      message: 'the traffic log has a day "Nov 1" that is not YYYY-MM-DD',
    });
    assert.throws(() => parseTrafficLog('{"days":{},"snapshots":[{"date":"x"}]}'), {
      message: 'the traffic log has a snapshot dated "x", not YYYY-MM-DD',
    });
  });

  it("counts days between two days", () => {
    assert.equal(daysBetween("2026-10-28", "2026-11-11"), 14);
    assert.equal(daysBetween("2026-11-11", "2026-11-10"), -1);
  });
});

describe("findProblems", () => {
  const healthyGoogle = {
    sitemapsLastRead: ["2026-11-28T08:00:00.000Z"],
    indexed: 44,
    crawledNotIndexed: [],
  };
  const healthy: Facts = {
    month: monthRange("2026-11"),
    sitemapUrls: 44,
    brokenUrls: [],
    google: healthyGoogle,
    bing: {
      inIndex: 40,
      sitemaps: [
        { url: "https://a.example/sitemap.xml", status: "Success", lastRead: "2026-11-25" },
      ],
    },
    context7: { lastUpdate: "2026-11-10T17:53:26.365Z" },
    latest: { version: "1.5.1", published: "2026-11-05T21:23:14.418Z" },
    downloads: [{ name: "hardhat-kms", total: 10 }],
    traffic: { logged: true, previousSnapshot: "2026-11-24", covered: 30, daysInMonth: 30 },
  };

  it("finds nothing in a healthy month", () => {
    assert.deepEqual(findProblems(healthy, "2026-12-01"), []);
  });

  it("names what 2026-11-11 looked like", () => {
    const problems = findProblems(
      {
        ...healthy,
        brokenUrls: ["https://a.example/gone (404)"],
        google: {
          sitemapsLastRead: [undefined, undefined],
          indexed: 11,
          crawledNotIndexed: ["https://a.example/safe"],
        },
        bing: { inIndex: 1, sitemaps: [] },
        context7: { lastUpdate: "2026-10-07T20:18:06.262Z" },
        downloads: [
          { name: "hardhat-kms", total: 10 },
          { name: "@hardhat-kms/safe", total: 0 },
        ],
        traffic: { logged: false },
      },
      "2026-11-11",
    );
    assert.deepEqual(problems, [
      "1 sitemap URLs do not answer 200: https://a.example/gone (404)",
      "Google has never read the sitemap; request indexing by hand for the pages it does not know.",
      "Google indexes 11 of the 44 sitemap URLs.",
      "Google crawled but did not index https://a.example/safe; another request does not help, a link from an indexed page or more content may.",
      "No sitemap is submitted to Bing.",
      "Bing indexes 1 of the 44 sitemap URLs.",
      "Context7 was last updated on 2026-10-07, before 1.5.1 (2026-11-05); run with --refresh-context7.",
      "@hardhat-kms/safe had no downloads in 2026-11.",
      "GitHub traffic is not logged; GitHub keeps 14 days, so run with --traffic-log every week.",
    ]);
  });

  it("names stale sitemaps, a missing Google sitemap and gaps in the traffic log", () => {
    const problems = findProblems(
      {
        ...healthy,
        google: { sitemapsLastRead: [], crawledNotIndexed: [] },
        bing: {
          sitemaps: [
            { url: "s1", status: "Pending" },
            { url: "s2", status: "Success", lastRead: "2026-11-01" },
          ],
        },
        traffic: { logged: true, previousSnapshot: "2026-11-01", covered: 20, daysInMonth: 30 },
      },
      "2026-12-01",
    );
    assert.deepEqual(problems, [
      "No sitemap is submitted to Google.",
      "Bing has never read s1 (Pending).",
      "Bing last read s2 on 2026-11-01 (Success).",
      "The traffic log's previous run was on 2026-11-01, more than 14 days ago; the days in between are lost.",
      "The traffic log holds 20 of the 30 days of 2026-11.",
    ]);
    assert.deepEqual(
      findProblems(
        { ...healthy, google: { ...healthyGoogle, sitemapsLastRead: ["2026-11-01T00:00:00Z"] } },
        "2026-11-20",
      ),
      ["Google last read the sitemap on 2026-11-01."],
    );
  });
});

describe("monthlyRow", () => {
  it("joins the cells in the table's order with an empty Notes cell", () => {
    assert.equal(
      monthlyRow({
        month: "2026-11",
        downloads: [1, 2, 3, 4, 5, 6],
        stars: "0",
        referrers: "none, the 14 days to 2026-11-11",
        npmPositions: '"hardhat kms": aws 1',
        indexed: "Google 11 / 44, Bing 1 / 44, read on 2026-11-11",
        impressions: "3, 0",
      }),
      '| 2026-11 | 1, 2, 3, 4, 5, 6 | 0 | none, the 14 days to 2026-11-11 | "hardhat kms": aws 1 | Google 11 / 44, Bing 1 / 44, read on 2026-11-11 | 3, 0 |  |',
    );
  });
});
