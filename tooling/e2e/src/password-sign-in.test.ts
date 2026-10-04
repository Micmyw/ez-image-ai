import assert from "node:assert/strict";
import test from "node:test";

import { submitPasswordSignIn } from "../../../apps/saas/tests/helpers/password-sign-in";

function response(status: number, retryAfter?: string) {
	return {
		status: () => status,
		headers: () => (retryAfter === undefined ? {} : { "x-retry-after": retryAfter }),
		url: () => "http://localhost:3000/api/auth/sign-in/email",
		request: () => ({ method: () => "POST" }),
	};
}

function createFixture(responses: ReturnType<typeof response>[]) {
	const events: string[] = [];
	const waits: number[] = [];
	const matchers: Array<(value: ReturnType<typeof response>) => boolean> = [];
	let resolveResponse: ((value: ReturnType<typeof response>) => void) | undefined;
	let clicks = 0;
	const page = {
		url: () => "http://localhost:3000/login",
		waitForResponse: (matcher: (value: ReturnType<typeof response>) => boolean) => {
			events.push("listen");
			matchers.push(matcher);
			return new Promise<ReturnType<typeof response>>((resolve) => {
				resolveResponse = resolve;
			});
		},
		locator: () => ({
			click: async () => {
				events.push("click");
				assert(resolveResponse, "response listener must be registered before click");
				const next = responses[clicks++];
				assert(next, "unexpected extra login attempt");
				resolveResponse(next);
			},
		}),
	};
	return {
		events,
		waits,
		matchers,
		run: () =>
			submitPasswordSignIn(
				page as unknown as Parameters<typeof submitPasswordSignIn>[0],
				async (ms) => {
					waits.push(ms);
				},
			),
	};
}

void test("HTTP 200 needs one submission and no cooldown", async () => {
	const fixture = createFixture([response(200)]);
	await fixture.run();
	assert.deepEqual(fixture.events, ["listen", "click"]);
	assert.deepEqual(fixture.waits, []);
	const matches = fixture.matchers[0]!;
	assert(matches(response(200)));
	assert(!matches({ ...response(200), request: () => ({ method: () => "GET" }) }));
	assert(!matches({ ...response(200), url: () => "http://localhost:3000/api/auth/get-session" }));
	assert(!matches({ ...response(200), url: () => "https://example.test/api/auth/sign-in/email" }));
});

for (const [header, milliseconds] of [
	["6", 6100],
	["0", 100],
	["0.0011", 1100],
	["10", 10100],
] as const) {
	void test(`one explicit 429 cooldown honors ${header} seconds, then submits once`, async () => {
		const fixture = createFixture([response(429, header), response(200)]);
		await fixture.run();
		assert.deepEqual(fixture.waits, [milliseconds]);
		assert.deepEqual(fixture.events, ["listen", "click", "listen", "click"]);
	});
}

for (const status of [400, 401, 403, 500]) {
	void test(`does not retry HTTP ${status}`, async () => {
		const fixture = createFixture([response(status, "1")]);
		await assert.rejects(fixture.run(), new RegExp(`PASSWORD_SIGN_IN_HTTP_${status}`));
		assert.deepEqual(fixture.waits, []);
		assert.deepEqual(fixture.events, ["listen", "click"]);
	});
}

for (const header of [undefined, "", "-1", "Infinity", "NaN", "tomorrow", "11", "10.1", " 1 "]) {
	void test(`rejects an absent or invalid cooldown: ${String(header)}`, async () => {
		const fixture = createFixture([response(429, header)]);
		await assert.rejects(fixture.run(), /PASSWORD_SIGN_IN_INVALID_RETRY_AFTER/);
		assert.deepEqual(fixture.waits, []);
		assert.deepEqual(fixture.events, ["listen", "click"]);
	});
}

void test("a second 429 fails without another wait or third submission", async () => {
	const fixture = createFixture([response(429, "1"), response(429, "1")]);
	await assert.rejects(fixture.run(), /PASSWORD_SIGN_IN_HTTP_429/);
	assert.deepEqual(fixture.waits, [1100]);
	assert.deepEqual(fixture.events, ["listen", "click", "listen", "click"]);
});
