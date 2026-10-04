import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { isExplicitGuestVerificationTarget } from "./guest-verification-target";
import { buildIntegrationPlan } from "./run-integration";

const main = "postgresql://fixture:fixture@127.0.0.1:55432/ai_media_foundation_test";
const guest = "postgresql://fixture:fixture@127.0.0.1:55440/ai_media_guest_test";
const video = "postgresql://fixture:fixture@127.0.0.1:55439/ezpic_video_v1_final_test";
const keys = [
	"TEST_DATABASE_URL",
	"GUEST_TEST_DATABASE_URL",
	"VIDEO_VERIFICATION_DATABASE_URL",
	"DATABASE_URL",
] as const;
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

beforeEach(() => {
	process.env.TEST_DATABASE_URL = main;
	process.env.GUEST_TEST_DATABASE_URL = guest;
	process.env.VIDEO_VERIFICATION_DATABASE_URL = video;
	delete process.env.DATABASE_URL;
});
afterEach(() => {
	for (const key of keys) {
		if (original[key] === undefined) delete process.env[key];
		else process.env[key] = original[key];
	}
});

const destructiveDatabaseFiles = [
	"anonymous-standard-schema",
	"guest-admission",
	"guest-bootstrap",
	"guest-link",
	"guest-retention",
	"admin-growth-operations",
].map((name) => `prisma/queries/media/${name}.integration.test.ts`);
const destructiveApiFiles = [
	"modules/media/guest-capability.database.integration.test.ts",
	"modules/media/guest-media.integration.test.ts",
	"modules/media/guest-admission-boundary.integration.test.ts",
	"modules/media/procedures/get-guest-eligibility.database.integration.test.ts",
	"modules/media/procedures/retry-generation.database.integration.test.ts",
];

void describe("integration suites use physically distinct disposable databases", () => {
	void it("isolates all destructive DB, Jobs and API suites while preserving ordinary and video coverage", () => {
		const commands = buildIntegrationPlan();
		const forPackage = (name: string) => commands.filter(({ args }) => args[1] === name);
		const database = forPackage("@repo/database");
		assert.equal(database.length, 3);
		const ordinary = database.find(({ environment }) => environment.TEST_DATABASE_URL === main)!;
		const destructive = database.find(
			({ environment }) => environment.TEST_DATABASE_URL === guest,
		)!;
		const handoff = database.find(({ environment }) => environment.TEST_DATABASE_URL === video)!;
		for (const file of destructiveDatabaseFiles) {
			assert.equal(ordinary.args[ordinary.args.indexOf(file) - 1], "--exclude", file);
			assert.ok(destructive.args.includes(file), file);
		}
		assert.equal(ordinary.environment.DATABASE_URL, undefined);
		assert.equal(destructive.environment.DATABASE_URL, undefined);
		const handoffFile =
			"prisma/queries/media/video-v1-seeapi-handoff-invariant.integration.test.ts";
		assert.ok(handoff.args.includes(handoffFile));
		assert.equal(ordinary.args[ordinary.args.indexOf(handoffFile) - 1], "--exclude");
		assert.equal(handoff.environment.DATABASE_URL, video);

		const jobs = forPackage("@repo/jobs");
		assert.equal(jobs.length, 2);
		const mainJobs = jobs.find(({ environment }) => environment.TEST_DATABASE_URL === main)!;
		const guestJobs = jobs.find(({ environment }) => environment.TEST_DATABASE_URL === guest)!;
		const runtimeStores = "src/handlers/runtime-stores.database.integration.test.ts";
		assert.ok(!mainJobs.args.includes(runtimeStores));
		assert.ok(guestJobs.args.includes(runtimeStores));
		assert.equal(guestJobs.environment.DATABASE_URL, guest);
		for (const file of ["flow", "seeapi-flow"])
			assert.ok(mainJobs.args.includes(`src/video-v1/${file}.database.integration.test.ts`));

		const api = forPackage("@repo/api");
		assert.equal(api.length, 2);
		const mainApi = api.find(({ environment }) => environment.TEST_DATABASE_URL === main)!;
		const guestApi = api.find(({ environment }) => environment.TEST_DATABASE_URL === guest)!;
		for (const file of destructiveApiFiles) {
			assert.equal(mainApi.args[mainApi.args.indexOf(file) - 1], "--exclude", file);
			assert.ok(guestApi.args.includes(file), file);
		}
		for (const command of api) {
			const runtime = new URL(command.environment.DATABASE_URL!);
			assert.equal(runtime.searchParams.get("application_name"), "ezpic-integration-runtime");
			runtime.searchParams.delete("application_name");
			assert.equal(runtime.href, command.environment.TEST_DATABASE_URL);
		}
	});

	void it("keeps API-only integration runs isolated", () => {
		const commands = buildIntegrationPlan("api");
		assert.equal(commands.length, 2);
		assert.ok(commands.every(({ args }) => args[1] === "@repo/api"));
		assert.deepEqual(
			commands.map(({ environment }) => environment.TEST_DATABASE_URL),
			[main, guest],
		);
	});

	void it("requires a separately approved guest target rather than falling back to the main database", () => {
		delete process.env.GUEST_TEST_DATABASE_URL;
		assert.throws(() => buildIntegrationPlan(), /GUEST_TEST_DATABASE_URL is required/);
	});

	for (const replacement of [
		guest,
		guest.replace("127.0.0.1", "localhost"),
		`${guest}?application_name=another-run`,
		guest.replace("fixture:fixture", "another:credential"),
		guest.replace("postgresql:", "postgres:"),
		guest.replace("ai_media_guest_test", "ai_media_guest_%74est"),
	]) {
		void it(`rejects a main database alias of the guest target: ${replacement}`, () => {
			process.env.TEST_DATABASE_URL = replacement;
			assert.throws(() => buildIntegrationPlan(), /DATABASE_TARGETS_MUST_BE_DISTINCT/);
		});
	}

	void it("also rejects a main database alias of the video target", () => {
		process.env.TEST_DATABASE_URL = video.replace("127.0.0.1", "localhost");
		assert.throws(() => buildIntegrationPlan(), /DATABASE_TARGETS_MUST_BE_DISTINCT/);
	});

	for (const databaseName of [
		"ai_media_guest_test",
		"ezpic_video_v1_final_test",
		"ezpic_video_v1_final_%74est",
		"EZPIC_VIDEO_V1_FINAL_TEST",
	]) {
		void it(`rejects duplicate normalized database names across port mappings: ${databaseName}`, () => {
			process.env.TEST_DATABASE_URL = main.replace("ai_media_foundation_test", databaseName);
			assert.throws(() => buildIntegrationPlan(), /DATABASE_TARGETS_MUST_BE_DISTINCT/);
		});
	}

	for (const unsafe of [
		guest.replace("127.0.0.1", "database.example.com"),
		guest.replace("55440", "5432"),
		guest.replace("ai_media_guest_test", "another_test"),
		`${guest}?host=database.example.com`,
		`${guest}?dbname=ai_media_foundation_test`,
		`${guest}?application_name=separate-looking`,
		`${guest}#separate-looking`,
	]) {
		void it(`rejects an unsafe or unapproved guest target: ${unsafe}`, () => {
			process.env.GUEST_TEST_DATABASE_URL = unsafe;
			assert.equal(isExplicitGuestVerificationTarget(new URL(unsafe)), false);
			assert.throws(() => buildIntegrationPlan());
		});
	}

	void it("requires the whole approved guest URL including credentials and query", () => {
		assert.equal(isExplicitGuestVerificationTarget(new URL(guest)), true);
		assert.equal(
			isExplicitGuestVerificationTarget(new URL(`${guest}?application_name=other`)),
			false,
		);
		assert.equal(
			isExplicitGuestVerificationTarget(new URL(guest.replace("fixture:fixture", "other:fixture"))),
			false,
		);
	});

	void it("rejects connection routing overrides on the main target", () => {
		process.env.TEST_DATABASE_URL = `${main}?host=localhost&port=55440`;
		assert.throws(() => buildIntegrationPlan(), /DATABASE_ROUTE_OVERRIDE_FORBIDDEN/);
	});

	void it("executes CLI validation before spawning any suite", () => {
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				"tsx",
				fileURLToPath(new URL("./run-integration.ts", import.meta.url)),
				"invalid",
			],
			{ encoding: "utf8" },
		);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /UNKNOWN_INTEGRATION_PHASE/);
	});
});
