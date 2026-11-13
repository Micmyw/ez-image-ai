import { IMAGE_PRODUCT_SELECTION_CONTRACTS } from "@repo/config";
import { describe, expect, it, vi } from "vitest";

import { staticDispatchRouteFor } from "../catalog/dispatch-manifest";
import type { ProviderSubmitInput } from "../types";
import fixture from "./fixtures/kie-seedream-5-5-contracts-2026-11-13.json";
import { KieProviderAdapter } from "./kie";

const sourceAsset = {
	assetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
	transferUrl: "https://transfer.test/private-reference.png",
};
const callbackUrl = "https://app.test/api/webhooks/ai/kie?token=server-signed";

function request(
	kind: "text-to-image" | "image-to-image",
	size = "1-5k",
	overrides: Record<string, unknown> = {},
): ProviderSubmitInput {
	return {
		attemptId: "seedream55-attempt",
		providerModelId: `seedream/5-5-${kind}`,
		webhookUrl: callbackUrl,
		input: {
			kind,
			prompt: "A cozy bookstore cafe on a rainy evening",
			skuKey: `seedream-5-5-${size}`,
			aspectRatio: "1:1",
			...(kind === "image-to-image" ? { sourceAsset } : {}),
			...overrides,
		},
	} as ProviderSubmitInput;
}

function capture() {
	const fetch = vi.fn<typeof globalThis.fetch>(async () =>
		Response.json({ code: 200, data: { taskId: "seedream55-task" } }),
	);
	return { fetch, adapter: new KieProviderAdapter({ apiKey: "test-key", fetch }) };
}

describe("Seedream 5.5 independently retrieved Kie contracts", () => {
	for (const kind of ["text-to-image", "image-to-image"] as const) {
		it.each(["1k", "1-5k", "2k"])(`${kind} submits the documented %s fields once`, async (size) => {
			const { fetch, adapter } = capture();
			const input = request(kind, size);
			const submission = await adapter.submit(input);
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(fetch.mock.calls[0]![0]).toBe("https://api.kie.ai/api/v1/jobs/createTask");
			const body = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
			expect(body).toEqual({
				model: `seedream/5-5-${kind}`,
				callBackUrl: callbackUrl,
				input: {
					prompt: input.input.prompt,
					aspect_ratio: "1:1",
					size: size.replace("-", ".").toUpperCase(),
					output_format: "png",
					background: "auto",
					nsfw_checker: true,
					...(kind === "image-to-image" ? { image_urls: [sourceAsset.transferUrl] } : {}),
				},
			});
			const schema = fixture.contracts.find((contract) => contract.model === body.model)!
				.requestSchema.properties.input;
			for (const field of Object.keys(body.input)) expect(schema.properties).toHaveProperty(field);
			for (const field of schema.required) expect(body.input).toHaveProperty(field);
			for (const [field, value] of Object.entries(body.input)) {
				const property = (schema.properties as Record<string, { enum?: unknown[] }>)[field];
				if (property?.enum) expect(property.enum).toContain(value);
			}
			expect(submission).toMatchObject({
				outcome: "accepted",
				providerTaskId: "seedream55-task",
				idempotency: { providerSupported: false, replayed: false },
				reconciliation: {
					submissionToken: "seedream55-attempt",
					statusUrl: "https://api.kie.ai/api/v1/jobs/recordInfo?taskId=seedream55-task",
				},
			});
			expect(staticDispatchRouteFor("image", "kie", input.providerModelId)).toBeDefined();
		});

		it.each(["1k", "1-5k", "2k"])(`${kind} supports native transparent PNG at %s`, async (size) => {
			const { fetch, adapter } = capture();
			await adapter.submit(request(kind, size, { background: "transparent", outputFormat: "png" }));
			expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).input).toMatchObject({
				output_format: "png",
				background: "transparent",
			});
		});

		it(`${kind} resolves automatic ratio without sending an undocumented enum`, async () => {
			const { fetch, adapter } = capture();
			await adapter.submit(request(kind, "1-5k", { aspectRatio: "auto" }));
			expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).input.aspect_ratio).toBe(
				kind === "text-to-image" ? "1:1" : "auto",
			);
		});
	}

	it("bounds public selections by the independent request schemas", () => {
		const contract = IMAGE_PRODUCT_SELECTION_CONTRACTS["image-seedream-5-5"];
		expect(contract.maximumInputBytes).toBe(10_000_000);
		for (const source of fixture.contracts) {
			const properties = source.requestSchema.properties.input.properties;
			expect(contract.minimumPromptLength).toBe(properties.prompt.minLength);
			expect(contract.maximumPromptLength).toBe(properties.prompt.maxLength);
			for (const cell of contract.cells) {
				expect(cell.aspectRatios.filter((ratio) => ratio !== "auto")).toEqual(
					properties.aspect_ratio.enum.filter((ratio) => ratio !== "auto"),
				);
				expect(cell.controls[0]!.options).toEqual(properties.output_format.enum);
				expect(cell.controls[1]!.options).toEqual(properties.background.enum);
			}
		}
	});

	it.each([
		{ aspectRatio: "1:8" },
		{ skuKey: "seedream-5-5-4k" },
		{ outputFormat: "gif" },
		{ outputFormat: "svg" },
		{ outputFormat: "jpeg", background: "transparent" },
		{ frameCount: 9 },
		{ prompt: "four" },
		{ prompt: "x".repeat(5001) },
	])("rejects unsupported raw requests before provider work: %j", async (overrides) => {
		const { fetch, adapter } = capture();
		await expect(adapter.submit(request("text-to-image", "1-5k", overrides))).rejects.toMatchObject(
			{ code: "UNSUPPORTED_INPUT" },
		);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("does not retry an uncertain submission", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => {
			throw new TypeError("Connection reset after send");
		});
		await expect(
			new KieProviderAdapter({ apiKey: "test-key", fetch }).submit(request("text-to-image")),
		).rejects.toMatchObject({ code: "HTTP_ERROR" });
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
