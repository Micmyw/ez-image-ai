import { describe, expect, it } from "vitest";

import { redactVideoAccessLog } from "./log-redaction";

describe("private video callback access logs", () => {
	it("redacts SeeAPI asset identity and complete callback proof query", () => {
		const result = redactVideoAccessLog(
			"POST /api/webhooks/video-v1/seeapi/private_asset?generation=2&attempt=3&proof=privateProof 202",
		);
		expect(result).toBe("POST /api/webhooks/video-v1/seeapi/[redacted] 202");
		expect(result).not.toMatch(/private_asset|privateProof|generation|attempt/);
	});
	it("preserves existing Kie token and playback grant redaction", () => {
		expect(redactVideoAccessLog("POST /api/webhooks/video/kie/token 202")).toBe(
			"POST /api/webhooks/video/kie/[redacted] 202",
		);
		expect(redactVideoAccessLog("GET /api/video-v1/jobs/job/content?grant=secret 206")).toBe(
			"GET /api/video-v1/jobs/job/content?[redacted] 206",
		);
	});
});
