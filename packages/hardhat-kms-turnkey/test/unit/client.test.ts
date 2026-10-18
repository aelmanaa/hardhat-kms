import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  defaultTransport,
  FIRST_BACKOFF_MS,
  MAX_ATTEMPTS,
  type RequestContext,
  TURNKEY_API_URL,
  TurnkeyClient,
} from "../../src/internal/client.ts";
import { apiKeyFromPrivateKey, verifyStamp } from "../../src/internal/stamp.ts";
import {
  ACCOUNT_SECRET_KEY,
  API_PRIVATE_KEY,
  API_PUBLIC_KEY,
  ORGANIZATION,
} from "../helpers/keys.ts";
import { BASE_URL, testTransport } from "../helpers/transport.ts";
import { SIGN_PATH, type StubAnswer, TurnkeyStub, turnkeyError } from "../helpers/turnkey-stub.ts";

const DISPLAY_ID = "turnkey:<TURNKEY_ORGANIZATION_ID>/0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const BODY = JSON.stringify({ organizationId: ORGANIZATION, timestampMs: "1" });
/** Turnkey's message, planted: no error may quote it. */
const TURNKEY_MESSAGE = 'request is targeting organization ("Planted Org Name")';

function setUp(options: { random?: number; onWait?: (ms: number) => void } = {}) {
  const stub = new TurnkeyStub({
    organizationId: ORGANIZATION,
    apiPublicKey: API_PUBLIC_KEY,
    secretKey: ACCOUNT_SECRET_KEY,
  });
  const transport = testTransport(stub, options);
  const apiKey = apiKeyFromPrivateKey(API_PRIVATE_KEY);
  assert.ok(apiKey);
  const client = new TurnkeyClient(transport, apiKey, DISPLAY_ID);
  const controller = new AbortController();
  const ctx: RequestContext = {
    signal: controller.signal,
    operation: "sign message",
    requestId: "req-1",
    forbiddenHint: " (the hint)",
  };
  return { stub, transport, client, controller, ctx };
}

function ok(): StubAnswer {
  return { status: 200, json: { activity: { id: "x" } } };
}

/** Checks the error's text, and that it quotes nothing from Turnkey's answer or the credentials. */
function failsWith(pattern: RegExp): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, pattern);
    assert.match(error.message, /^turnkey, sign message, key turnkey:<TURNKEY_ORGANIZATION_ID>\//);
    for (const planted of [
      TURNKEY_MESSAGE,
      "Planted Org Name",
      ORGANIZATION,
      API_PRIVATE_KEY,
      API_PUBLIC_KEY,
    ]) {
      assert.ok(!error.message.includes(planted), `${planted} in ${error.message}`);
    }
    return true;
  };
}

describe("TurnkeyClient requests", () => {
  it("posts the body with a valid stamp, JSON content, no redirects and the call's signal", async () => {
    const { stub, client, ctx, transport } = setUp();
    const seen: RequestInit[] = [];
    const fetch = stub.fetch;
    transport.fetch = async (input, init) => {
      seen.push(init ?? {});
      assert.equal(input, `${BASE_URL}${SIGN_PATH}`);
      return await fetch(input, init);
    };
    stub.answer(ok());

    const answer = await client.send(SIGN_PATH, BODY, ctx);

    assert.equal(answer.status, 200);
    const [init] = seen;
    assert.ok(init);
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "manual");
    assert.equal(init.signal, ctx.signal);
    assert.equal(init.body, BODY);
    const headers = new Headers(init.headers);
    assert.equal(headers.get("content-type"), "application/json");
    assert.equal(verifyStamp(headers.get("x-stamp") ?? "", BODY, API_PUBLIC_KEY), true);
    assert.equal(stub.requests[0]?.stamped, true);
  });

  it("returns a 2xx answer's JSON, or undefined when it is not JSON", async () => {
    const { stub, client, ctx } = setUp();
    stub.answer({ status: 201, json: { a: 1 } }, { status: 200, text: "not json" });
    assert.deepEqual(await client.send(SIGN_PATH, BODY, ctx), { status: 201, body: { a: 1 } });
    assert.deepEqual(await client.send(SIGN_PATH, BODY, ctx), { status: 200, body: undefined });
  });

  it("uses Turnkey's API by default", () => {
    const transport = defaultTransport();
    assert.equal(TURNKEY_API_URL, "https://api.turnkey.com");
    assert.equal(transport.baseUrl, TURNKEY_API_URL);
    assert.equal(transport.fetch, globalThis.fetch);
    assert.ok(Math.abs(transport.now() - Date.now()) < 1000);
    const random = transport.random();
    assert.ok(random >= 0 && random < 1);
  });

  it("waits with the system timers, and stops waiting when the signal aborts", async () => {
    const transport = defaultTransport();
    const started = Date.now();
    await transport.sleep(20, new AbortController().signal);
    assert.ok(Date.now() - started >= 15);

    const controller = new AbortController();
    const reason = new Error("stop");
    const waiting = transport.sleep(60_000, controller.signal);
    controller.abort(reason);
    await assert.rejects(waiting, (error) => error === reason);
  });
});

describe("TurnkeyClient retries", () => {
  for (const [name, failure] of [
    ["a 500", turnkeyError(500, "INTERNAL", TURNKEY_MESSAGE)],
    ["a 503 without a body", { status: 503, text: "" }],
    ["a 429 RATE_LIMIT_EXCEEDED", turnkeyError(429, "RATE_LIMIT_EXCEEDED", TURNKEY_MESSAGE)],
    ["a 429 without a code", turnkeyError(429, undefined, TURNKEY_MESSAGE)],
  ] as const) {
    it(`resends the same bytes after ${name}, and returns the answer that follows`, async () => {
      const { stub, client, ctx, transport } = setUp();
      stub.answer(failure, failure, ok());

      const answer = await client.send(SIGN_PATH, BODY, ctx);

      assert.equal(answer.status, 200);
      assert.deepEqual(
        stub.requests.map((request) => request.body),
        [BODY, BODY, BODY],
      );
      // A new stamp each time, each valid for the same body.
      assert.equal(new Set(stub.requests.map((request) => request.stamp)).size, 3);
      assert.ok(stub.requests.every((request) => request.stamped));
      assert.deepEqual(transport.waits, [188, 375]);
    });
  }

  it("makes at most 4 attempts, then explains a server error with its status and code", async () => {
    const { stub, client, ctx, transport } = setUp();
    for (let index = 0; index < 5; index++) {
      stub.answer(turnkeyError(500, "INTERNAL", TURNKEY_MESSAGE));
    }

    await assert.rejects(
      client.send(SIGN_PATH, BODY, ctx),
      failsWith(/: Turnkey answered 500 INTERNAL$/),
    );
    assert.equal(MAX_ATTEMPTS, 4);
    assert.equal(stub.requests.length, 4);
    assert.deepEqual(transport.waits, [188, 375, 750]);
  });

  it("backs off from 250 ms, doubling, each wait between half and all of the step", async () => {
    assert.equal(FIRST_BACKOFF_MS, 250);
    for (const [random, waits] of [
      [0, [125, 250, 500]],
      [0.999, [250, 500, 1000]],
    ] as const) {
      const { stub, client, ctx, transport } = setUp({ random });
      for (let index = 0; index < 4; index++) {
        stub.answer({ status: 502, text: "" });
      }
      await assert.rejects(client.send(SIGN_PATH, BODY, ctx), failsWith(/Turnkey answered 502$/));
      assert.deepEqual(transport.waits, waits);
    }
  });

  it("reports a rate limit that outlasts the retries as throttled, with the attempts", async () => {
    for (const code of ["RATE_LIMIT_EXCEEDED", undefined]) {
      const { stub, client, ctx } = setUp();
      for (let index = 0; index < 4; index++) {
        stub.answer(turnkeyError(429, code, TURNKEY_MESSAGE));
      }
      await assert.rejects(
        client.send(SIGN_PATH, BODY, ctx),
        failsWith(
          new RegExp(
            `Turnkey answered 429${code === undefined ? "" : ` ${code}`} 4 times: too many requests\\. The Free and Pay-as-you-go plans allow 1 request a second`,
          ),
        ),
      );
      assert.equal(stub.requests.length, 4);
    }
  });

  it("does not retry a used-up signing quota", async () => {
    const { stub, client, ctx, transport } = setUp();
    stub.answer(turnkeyError(429, "SIGNING_QUOTA_EXCEEDED", TURNKEY_MESSAGE));

    await assert.rejects(
      client.send(SIGN_PATH, BODY, ctx),
      failsWith(
        /Turnkey answered 429 SIGNING_QUOTA_EXCEEDED: the organization has used up its monthly signing quota/,
      ),
    );
    assert.equal(stub.requests.length, 1);
    assert.deepEqual(transport.waits, []);
  });

  it("does not retry a 429 with another code", async () => {
    const { stub, client, ctx } = setUp();
    stub.answer(turnkeyError(429, "SOMETHING_ELSE"));
    await assert.rejects(
      client.send(SIGN_PATH, BODY, ctx),
      failsWith(/Turnkey answered 429 SOMETHING_ELSE$/),
    );
    assert.equal(stub.requests.length, 1);
  });

  it("retries a request that got no answer, then names the error's code", async () => {
    const { client, ctx, transport } = setUp();
    let calls = 0;
    transport.fetch = async () => {
      calls++;
      throw new TypeError("fetch failed: api.turnkey.com", {
        cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), {
          code: "ECONNREFUSED",
        }),
      });
    };

    await assert.rejects(
      client.send(SIGN_PATH, BODY, ctx),
      failsWith(
        /Turnkey could not be reached after 4 attempts \(ECONNREFUSED\)\. Check the network and any proxy$/,
      ),
    );
    assert.equal(calls, 4);
    assert.deepEqual(transport.waits, [188, 375, 750]);
  });

  it("names the error's class when its code is not one it may show", async () => {
    const cases: Array<[unknown, string]> = [
      [new TypeError("fetch failed", { cause: { code: "lower case" } }), "TypeError"],
      [new TypeError("fetch failed", { cause: "text" }), "TypeError"],
      [new TypeError("fetch failed", { cause: null }), "TypeError"],
      // A code that is not a string, even one whose text would pass.
      [new TypeError("fetch failed", { cause: { code: ["ECONNREFUSED"] } }), "TypeError"],
      [Object.assign(new Error("x"), { name: "bad name!" }), "Error"],
      [Object.assign(new Error("x"), { name: "1Bad" }), "Error"],
      ["a string", "Error"],
    ];
    for (const [thrown, reason] of cases) {
      const { client, ctx, transport } = setUp();
      transport.fetch = async () => {
        throw thrown;
      };
      await assert.rejects(
        client.send(SIGN_PATH, BODY, ctx),
        failsWith(new RegExp(`after 4 attempts \\(${reason}\\)`)),
      );
    }
  });

  it("succeeds when an attempt after a lost answer gets through", async () => {
    const { stub, client, ctx, transport } = setUp();
    let calls = 0;
    const fetch = stub.fetch;
    transport.fetch = async (input, init) => {
      calls++;
      if (calls < 4) {
        throw new TypeError("fetch failed");
      }
      return await fetch(input, init);
    };
    stub.answer(ok());
    assert.equal((await client.send(SIGN_PATH, BODY, ctx)).status, 200);
    assert.equal(calls, 4);
  });
});

describe("TurnkeyClient answers", () => {
  const cases: Array<[string, StubAnswer, RegExp]> = [
    [
      "400",
      turnkeyError(400, "REQUEST_INVALID", TURNKEY_MESSAGE),
      /Turnkey answered 400 REQUEST_INVALID: it refused the request\. Check that `address` is a wallet account/,
    ],
    [
      "401",
      turnkeyError(401, "PUBLIC_KEY_NOT_FOUND", TURNKEY_MESSAGE),
      /Turnkey answered 401 PUBLIC_KEY_NOT_FOUND: it did not accept the API key/,
    ],
    [
      "401 without a body",
      { status: 401, text: "" },
      /Turnkey answered 401: it did not accept the API key/,
    ],
    [
      "403",
      turnkeyError(403, "REQUEST_NOT_AUTHORIZED", TURNKEY_MESSAGE),
      /Turnkey answered 403 REQUEST_NOT_AUTHORIZED: no policy lets the API key's user sign this request with this address \(the hint\)\. Add a policy/,
    ],
    [
      "404",
      turnkeyError(404, "ORGANIZATION_NOT_FOUND", TURNKEY_MESSAGE),
      /Turnkey answered 404 ORGANIZATION_NOT_FOUND: the organization was not found/,
    ],
    ["409", turnkeyError(409, "CONFLICT", TURNKEY_MESSAGE), /: Turnkey answered 409 CONFLICT$/],
    [
      "499 with a code that is not shown",
      turnkeyError(499, "lower", TURNKEY_MESSAGE),
      /: Turnkey answered 499$/,
    ],
    [
      "a stale timestamp",
      turnkeyError(401, "UNAUTHENTICATED", "timestamp is not current"),
      /Turnkey answered 401 UNAUTHENTICATED: it refused the request's time/,
    ],
    [
      "a future timestamp",
      turnkeyError(400, undefined, "the Timestamp is in the future"),
      /Turnkey answered 400: it refused the request's time.*at most 5 minutes ahead/,
    ],
    [
      "a timestamp code",
      turnkeyError(400, "TIMESTAMP_EXPIRED"),
      /Turnkey answered 400 TIMESTAMP_EXPIRED: it refused the request's time/,
    ],
    [
      "a timestamp word on a 403",
      turnkeyError(403, undefined, "timestamp"),
      /Turnkey answered 403: no policy/,
    ],
    [
      "a timestamp word on a 404",
      turnkeyError(404, undefined, "timestamp"),
      /Turnkey answered 404: the organization was not found/,
    ],
    [
      "a message that is not text",
      { status: 401, json: { message: 12, details: [] } },
      /Turnkey answered 401: it did not accept/,
    ],
    [
      "a message that is a list",
      { status: 401, json: { message: ["timestamp"], details: [] } },
      /Turnkey answered 401: it did not accept/,
    ],
    ["a null body", { status: 403, text: "null" }, /Turnkey answered 403: no policy/],
    [
      "a code that starts with a digit",
      turnkeyError(403, "1CODE"),
      /Turnkey answered 403: no policy/,
    ],
    ["a code with a dash", turnkeyError(403, "CODE-1"), /Turnkey answered 403: no policy/],
    [
      "a code that is not a string",
      { status: 403, json: { details: [{ turnkeyErrorCode: ["CODE"] }] } },
      /Turnkey answered 403: no policy/,
    ],
    [
      "a null body on a 401",
      { status: 401, text: "null" },
      /Turnkey answered 401: it did not accept/,
    ],
  ];
  for (const [name, answer, pattern] of cases) {
    it(`explains ${name}, without a retry`, async () => {
      const { stub, client, ctx, transport } = setUp();
      stub.answer(answer);
      await assert.rejects(client.send(SIGN_PATH, BODY, ctx), failsWith(pattern));
      assert.equal(stub.requests.length, 1);
      assert.deepEqual(transport.waits, []);
    });
  }

  it("reads the first code it may show among the details", async () => {
    const { stub, client, ctx } = setUp();
    stub.answer({
      status: 403,
      json: {
        message: TURNKEY_MESSAGE,
        details: [
          null,
          "TEXT",
          { turnkeyErrorCode: "bad code" },
          { turnkeyErrorCode: "FIRST" },
          { turnkeyErrorCode: "SECOND" },
        ],
      },
    });
    await assert.rejects(
      client.send(SIGN_PATH, BODY, ctx),
      failsWith(/Turnkey answered 403 FIRST:/),
    );
  });

  for (const status of [301, 302, 307, 308, 399]) {
    it(`refuses a ${status} and does not follow it`, async () => {
      const { stub, client, ctx } = setUp();
      stub.answer({ status, text: "", headers: { location: "https://elsewhere.test/collect" } });
      await assert.rejects(
        client.send(SIGN_PATH, BODY, ctx),
        failsWith(
          new RegExp(
            `Turnkey answered ${status}, a redirect\\. The plugin does not follow redirects`,
          ),
        ),
      );
      assert.equal(stub.requests.length, 1);
    });
  }

  it("refuses an opaque redirect, which has no status", async () => {
    const { client, ctx, transport } = setUp();
    transport.fetch = async () => {
      const response = new Response(null, { status: 200 });
      Object.defineProperty(response, "type", { value: "opaqueredirect" });
      Object.defineProperty(response, "status", { value: 0 });
      return await Promise.resolve(response);
    };
    await assert.rejects(
      client.send(SIGN_PATH, BODY, ctx),
      failsWith(/Turnkey answered 3xx, a redirect/),
    );
  });

  it("takes a 299 as an answer and a 300 as a redirect", async () => {
    const { stub, client, ctx } = setUp();
    stub.answer({ status: 299, json: {} }, { status: 300, text: "" });
    assert.equal((await client.send(SIGN_PATH, BODY, ctx)).status, 299);
    await assert.rejects(
      client.send(SIGN_PATH, BODY, ctx),
      failsWith(/Turnkey answered 300, a redirect/),
    );
  });
});

describe("TurnkeyClient and the signal", () => {
  it("checks the signal itself before each request, whatever fetch does with it", async () => {
    const { client, ctx, controller, transport } = setUp();
    let calls = 0;
    transport.fetch = async () => {
      calls++;
      return await Promise.resolve(new Response("{}", { status: 200 }));
    };
    const reason = new Error("timed out");
    controller.abort(reason);
    await assert.rejects(client.send(SIGN_PATH, BODY, ctx), (error) => error === reason);
    assert.equal(calls, 0);
  });

  it("reports the abort, not a lost answer, when the signal aborts during the last attempt", async () => {
    const { client, ctx, controller, transport } = setUp();
    let calls = 0;
    const reason = new Error("timed out");
    transport.fetch = async () => {
      calls++;
      if (calls === MAX_ATTEMPTS) {
        controller.abort(reason);
      }
      return await Promise.reject(new TypeError("fetch failed"));
    };
    await assert.rejects(client.send(SIGN_PATH, BODY, ctx), (error) => error === reason);
    assert.equal(calls, MAX_ATTEMPTS);
  });

  it("sends nothing once the signal has aborted", async () => {
    const { stub, client, ctx, controller } = setUp();
    const reason = new Error("timed out");
    controller.abort(reason);
    await assert.rejects(client.send(SIGN_PATH, BODY, ctx), (error) => error === reason);
    assert.equal(stub.requests.length, 0);
  });

  it("stops at once when the signal aborts during a request", async () => {
    const { client, ctx, controller, transport } = setUp();
    let calls = 0;
    transport.fetch = async (_input, init) => {
      calls++;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    };
    const reason = new Error("timed out");
    const sending = client.send(SIGN_PATH, BODY, ctx);
    controller.abort(reason);
    await assert.rejects(sending, (error) => error === reason);
    assert.equal(calls, 1);
    assert.deepEqual(transport.waits, []);
  });

  it("stops at once when the signal aborts during a wait, and sends nothing after", async () => {
    const controller = new AbortController();
    const reason = new Error("timed out");
    const { stub, client, transport } = setUp({ onWait: () => controller.abort(reason) });
    stub.answer({ status: 500, text: "" }, ok());
    await assert.rejects(
      client.send(SIGN_PATH, BODY, {
        signal: controller.signal,
        operation: "sign message",
        requestId: "r",
        forbiddenHint: "",
      }),
      (error) => error === reason,
    );
    assert.equal(stub.requests.length, 1);
    assert.equal(transport.waits.length, 1);
  });
});
