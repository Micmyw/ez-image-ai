import { describe, expect, it } from "vitest";

import { redactVideoAccessLog } from "./log-redaction";

describe("private video callback access logs", () => {
	it("redacts signed original-image capabilities", () => {
		expect(
			redactVideoAccessLog("GET /api/media/original?key=private&signature=secret&scope=admin 200"),
		).toBe("GET /api/media/original?[redacted] 200");
	});
	it("redacts source generation and role callback capabilities", () => {
		expect(redactVideoAccessLog("POST /api/webhooks/video-source/seeapi/private-token 202")).toBe(
			"POST /api/webhooks/video-source/[redacted] 202",
		);
		expect(
			redactVideoAccessLog(
				"POST /api/webhooks/video-source-input/private-job/performer-2/private-token 202",
			),
		).toBe("POST /api/webhooks/video-source-input/[redacted] 202");
	});
	it("redacts image moderation callback identity and proof", () => {
		expect(
			redactVideoAccessLog(
				"POST /api/webhooks/moderation/seeapi-image?asset=private&generation=1&submission=private&token=secret 202",
			),
		).toBe("POST /api/webhooks/moderation/seeapi-image?[redacted] 202");
	});
	it("redacts the template scene callback token", () => {
		expect(
			redactVideoAccessLog(
				"POST /api/webhooks/video-template/kie/private-scene-token?proof=secret 202",
			),
		).toBe("POST /api/webhooks/video-template/kie/[redacted] 202");
	});
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
