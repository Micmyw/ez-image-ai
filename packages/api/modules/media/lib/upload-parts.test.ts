import { describe, expect, it } from "vitest";

import { getMultipartPartPlan, validateMultipartCompletionParts } from "./upload-parts";

describe("multipart upload part policy", () => {
	it("binds each signable part to the declared total bytes", () => {
		expect(getMultipartPartPlan(17, 8, 1)).toEqual({ contentLength: 8, partCount: 3 });
		expect(getMultipartPartPlan(17, 8, 3)).toEqual({ contentLength: 1, partCount: 3 });
		expect(() => getMultipartPartPlan(17, 8, 4)).toThrow("part number");
	});

	it("requires one ordered unique completion entry for every expected part", () => {
		expect(() =>
			validateMultipartCompletionParts(
				[
					{ partNumber: 1, etag: "one" },
					{ partNumber: 2, etag: "two" },
					{ partNumber: 3, etag: "three" },
				],
				17,
				8,
			),
		).not.toThrow();
		expect(() =>
			validateMultipartCompletionParts(
				[
					{ partNumber: 1, etag: "one" },
					{ partNumber: 1, etag: "duplicate" },
				],
				17,
				8,
			),
		).toThrow("ordered");
		expect(() =>
			validateMultipartCompletionParts(
				[
					{ partNumber: 2, etag: "two" },
					{ partNumber: 1, etag: "one" },
					{ partNumber: 3, etag: "three" },
				],
				17,
				8,
			),
		).toThrow("ordered");
		expect(() =>
			validateMultipartCompletionParts(
				[
					{ partNumber: 1, etag: "one" },
					{ partNumber: 2, etag: "two" },
				],
				17,
				8,
			),
		).toThrow("every expected part");
	});
});
