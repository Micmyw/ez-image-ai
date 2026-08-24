import { describe, expect, it } from "vitest";

import {
	createOutputTransferEnvelope,
	parseOutputTransferEnvelope,
	providerOutputsFromTransferEnvelope,
	responseSnapshotForResult,
} from "./output-transfer-envelope";

describe("provider output transfer envelopes", () => {
	it("keeps signed transfer material out of the ordinary attempt snapshot", () => {
		const signedUrl =
			"https://replicate.delivery/output.png?X-Amz-Credential=temporary&X-Amz-Signature=secret";
		const envelope = createOutputTransferEnvelope("image", [
			{
				kind: "remote-url",
				url: signedUrl,
				trust: "untrusted-transfer-candidate",
				rawProviderField: "must-not-persist",
			} as never,
		]);

		expect(envelope).toEqual({
			version: 1,
			outputs: [{ kind: "remote-url", url: signedUrl }],
		});
		expect(parseOutputTransferEnvelope("image", envelope)).toEqual(envelope);
		const ordinarySnapshot = responseSnapshotForResult({
			outputs: [
				{
					kind: "remote-url",
					url: signedUrl,
					trust: "untrusted-transfer-candidate",
				},
			],
			providerCharged: true,
		});
		expect(ordinarySnapshot).toEqual({ providerCharged: true, outputCount: 1 });
		expect(JSON.stringify(ordinarySnapshot)).not.toContain("X-Amz-Signature");
	});

	it("rejects unsafe, oversized, and malformed outputs", () => {
		const malformedBase64 = "%%%not-base64%%%";
		expect(
			createOutputTransferEnvelope("image", [
				{
					kind: "remote-url",
					url: "http://replicate.delivery/not-https.png",
					trust: "untrusted-transfer-candidate",
				},
			]),
		).toBeNull();
		expect(
			createOutputTransferEnvelope("image", [
				{
					kind: "remote-url",
					url: "https://user:password@replicate.delivery/credential-leak.png",
					trust: "untrusted-transfer-candidate",
				},
			]),
		).toBeNull();
		expect(
			parseOutputTransferEnvelope("image", {
				version: 1,
				outputs: [
					{
						kind: "inline-base64",
						mimeType: "image/png",
						data: malformedBase64,
						unknown: "must-not-survive",
					},
				],
			}),
		).toBeNull();
	});

	it("enforces output-count, URL, and aggregate inline-media limits", () => {
		const remoteOutput = {
			kind: "remote-url" as const,
			url: "https://replicate.delivery/output.png",
			trust: "untrusted-transfer-candidate" as const,
		};
		expect(
			createOutputTransferEnvelope(
				"image",
				Array.from({ length: 5 }, () => remoteOutput),
			),
		).toBeNull();
		expect(
			createOutputTransferEnvelope("image", [
				{
					...remoteOutput,
					url: `https://replicate.delivery/${"a".repeat(4_072)}.png`,
				},
			]),
		).toBeNull();

		const elevenMiB = Buffer.alloc(11 * 1024 * 1024).toString("base64");
		const inlineOutput = {
			kind: "inline-base64" as const,
			mimeType: "image/png",
			data: elevenMiB,
			trust: "untrusted-transfer-candidate" as const,
		};
		expect(createOutputTransferEnvelope("image", [inlineOutput, inlineOutput])).toBeNull();
	});

	it("does not reconstruct image-only inline data for video finalization", () => {
		expect(
			providerOutputsFromTransferEnvelope("video", {
				version: 1,
				outputs: [{ kind: "inline-base64", mimeType: "image/png", data: "aGVsbG8=" }],
			}),
		).toEqual([]);
	});
});
