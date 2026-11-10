// The parsing of scripts/adoption-search.ts, fed with answers shaped like the ones Search Console,
// Bing Webmaster Tools and the sitemap gave on 2026-11-10. Runs in `pnpm test`, with no network.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  analyticsRows,
  bingDay,
  bingIndexed,
  bingMonthTraffic,
  bingQueries,
  monthRange,
  redactKey,
  sitemapUrls,
  tally,
} from "../../scripts/adoption-search.ts";

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
