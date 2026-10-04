import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";

const runner = readFileSync(new URL("./local-command.mjs", import.meta.url), "utf8").replace(
	/^import .*;\r?\n/gm,
	"",
);
const testDatabaseUrl = "postgresql://fixture:fixture@127.0.0.1:55432/video_ui_test";

function dispatch(environment = {}) {
	const calls = [];
	const child = { pid: 4321, once() {} };
	runInNewContext(runner, {
		process: {
			env: {
				VIDEO_VERIFICATION_DATABASE_URL: testDatabaseUrl,
				KIE_API_KEY: "must-be-cleared",
				...environment,
			},
			argv: ["node", "local-command.mjs", "e2e:media:video-ui"],
			cwd: () => "/isolated-video-fixture",
			platform: "linux",
			pid: 1234,
		},
		// Inspect the real runner's dispatch without starting any process or reading env values.
		spawn: (executable, args, options) => {
			calls.push({ executable, args, environment: options.env });
			return child;
		},
		existsSync: (path) => path.endsWith(".env.local"),
		readFileSync: () => "E2E_USE_PRODUCTION_BUILD=false\nKIE_API_KEY=unused\n",
		writeFileSync() {},
		mkdirSync() {},
		resolve,
		pathToFileURL,
		URL,
	});
	assert.equal(calls.length, 1);
	return calls[0];
}

void test("an explicit local production-build opt-in reaches the guarded E2E runner", () => {
	const call = dispatch({ E2E_USE_PRODUCTION_BUILD: "true" });
	assert.equal(call.environment.E2E_USE_PRODUCTION_BUILD, "true");
	assert.equal(call.args.at(-1), "--video-ui");
	assert.equal(call.environment.TEST_DATABASE_URL, testDatabaseUrl);
	assert.equal(call.environment.NEXT_PUBLIC_SAAS_URL, "http://127.0.0.1:3349");
	assert.equal(call.environment.KIE_API_KEY, "");
	assert.equal(call.environment.VIDEO_V1_ENABLED, "false");
	assert.equal(call.environment.VIDEO_TEST_ALLOW_FONT_DOWNLOADS, "true");
	assert.match(call.environment.NODE_OPTIONS, /tests\/video-v1\/no-paid-network\.mjs/);
});

for (const value of [undefined, "false", "", "TRUE", "1"]) {
	void test(`production-build stays disabled without literal true: ${String(value)}`, () => {
		assert.equal(
			dispatch({ E2E_USE_PRODUCTION_BUILD: value }).environment.E2E_USE_PRODUCTION_BUILD,
			"false",
		);
	});
}

for (const databaseUrl of [
	undefined,
	"postgresql://fixture:fixture@remote.example/video_ui_test",
]) {
	void test(`production-build opt-in cannot bypass the explicit local database guard: ${String(databaseUrl)}`, () => {
		assert.throws(
			() =>
				dispatch({
					E2E_USE_PRODUCTION_BUILD: "true",
					VIDEO_VERIFICATION_DATABASE_URL: databaseUrl,
				}),
			/EXPLICIT_ISOLATED_VIDEO_VERIFICATION_DATABASE_REQUIRED/,
		);
	});
}
