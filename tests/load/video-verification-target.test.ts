import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { isExplicitVideoVerificationTarget } from "./video-verification-target";

const target = "postgresql://fixture:fixture@127.0.0.1:55439/ezpic_video_v1_final_test";
const originalApproval = process.env.VIDEO_VERIFICATION_DATABASE_URL;

void describe("explicit video final-verification database target", () => {
	afterEach(() => {
		if (originalApproval === undefined) delete process.env.VIDEO_VERIFICATION_DATABASE_URL;
		else process.env.VIDEO_VERIFICATION_DATABASE_URL = originalApproval;
	});
	void it("requires the complete explicitly approved URL", () => {
		process.env.VIDEO_VERIFICATION_DATABASE_URL = "";
		assert.equal(isExplicitVideoVerificationTarget(new URL(target)), false);
		process.env.VIDEO_VERIFICATION_DATABASE_URL = target;
		assert.equal(isExplicitVideoVerificationTarget(new URL(target)), true);
		for (const different of [
			target.replace("fixture:fixture", "other:fixture"),
			target.replace(":55439", ":55440"),
			`${target}?schema=public`,
		]) {
			assert.equal(isExplicitVideoVerificationTarget(new URL(different)), false);
		}
	});
	for (const value of [
		target.replace("127.0.0.1", "database.example.com"),
		target.replace(":55439", ":5432"),
		target.replace(":55439", ":49151"),
		target.replace(":55439", ""),
		target.replace("ezpic_video_v1_final_test", "production"),
		target.replace("ezpic_video_v1_final_test", "another_test"),
		target.replace("postgresql:", "https:"),
		`${target}?host=database.example.com`,
		`${target}?dbname=production`,
		`${target}#fixture`,
	]) {
		void it(`rejects unsafe or different targets even when explicitly supplied: ${value}`, () => {
			process.env.VIDEO_VERIFICATION_DATABASE_URL = value;
			assert.equal(isExplicitVideoVerificationTarget(new URL(value)), false);
		});
	}
	for (const scheme of ["postgres", "postgresql"]) {
		void it(`accepts ${scheme} on localhost only when the URL matches`, () => {
			const value = target.replace("postgresql:", `${scheme}:`).replace("127.0.0.1", "localhost");
			process.env.VIDEO_VERIFICATION_DATABASE_URL = value;
			assert.equal(isExplicitVideoVerificationTarget(new URL(value)), true);
		});
	}
	void it("fails closed on malformed approval", () => {
		process.env.VIDEO_VERIFICATION_DATABASE_URL = "invalid";
		assert.equal(isExplicitVideoVerificationTarget(new URL(target)), false);
	});
	void it("accepts a separately approved high-port fixture without reusing another task's port", () => {
		for (const port of [49152, 55440, 65535]) {
			const alternative = target.replace(":55439", `:${port}`);
			process.env.VIDEO_VERIFICATION_DATABASE_URL = alternative;
			assert.equal(isExplicitVideoVerificationTarget(new URL(alternative)), true);
			assert.equal(isExplicitVideoVerificationTarget(new URL(target)), false);
		}
	});
	void it("accepts the separate browser fixture database only with exact explicit selection", () => {
		const browserTarget = target.replace("final_test", "e2e_test");
		process.env.VIDEO_VERIFICATION_DATABASE_URL = target;
		assert.equal(isExplicitVideoVerificationTarget(new URL(browserTarget)), false);
		process.env.VIDEO_VERIFICATION_DATABASE_URL = browserTarget;
		assert.equal(isExplicitVideoVerificationTarget(new URL(browserTarget)), true);
	});
});
