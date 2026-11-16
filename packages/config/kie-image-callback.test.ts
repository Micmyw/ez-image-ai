import { describe, expect, it } from "vitest";

import { parseKieImageCallbackCompletion } from "./kie-image-callback";

const options = {
	allowedHosts: ["tempfile.aiquickdraw.com"],
	receivedAt: new Date("2026-11-16T08:00:00Z"),
};
const image = "https://tempfile.aiquickdraw.com/result.png";
function body(model: string, urls = [image]) {
	return {
		code: 200,
		data: {
			taskId: "task-1",
			model,
			state: "success",
			resultJson: JSON.stringify({ resultUrls: urls }),
		},
	};
}
describe("Kie Market image success callback candidates", () => {
	it.each([null, -1, "invalid", 1e30, 0.00001])(
		"keeps a usable result when optional cost is invalid: %j",
		(creditsConsumed) => {
			const value = body("nano-banana-2-lite");
			const parsed = parseKieImageCallbackCompletion(
				{ ...value, data: { ...value.data, creditsConsumed } },
				options,
			);
			expect(parsed?.outputUrl).toBe(image);
			expect(parsed?.creditsConsumed).toBeUndefined();
		},
	);
	it.each(["minimax-h3/image-edit", "nano-banana-2-lite", "seedream/5-5-image-to-image"])(
		"accepts the documented callback result shape for %s",
		(model) => {
			expect(parseKieImageCallbackCompletion(body(model), options)).toMatchObject({
				providerModelId: model,
				outputUrl: image,
			});
		},
	);
	it.each(
		[
			[],
			[image, image],
			["http://tempfile.aiquickdraw.com/a.png"],
			["https://evil.test/a.png"],
			["https://user:password@tempfile.aiquickdraw.com/a.png"],
			["https://tempfile.aiquickdraw.com/a.png#fragment"],
			["https://tempfile.aiquickdraw.com:8080/a.png"],
			["https://tempfile.aiquickdraw.com.evil.test/a.png"],
		].map((urls) => ({ urls })),
	)("leaves incomplete, ambiguous and unsafe results to retrieval: %j", ({ urls }) => {
		expect(
			parseKieImageCallbackCompletion(body("nano-banana-2-lite", urls), options),
		).toBeUndefined();
	});
});
