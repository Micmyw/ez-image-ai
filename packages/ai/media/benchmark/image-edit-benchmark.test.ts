import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
	FalProviderAdapter,
	GeminiProviderAdapter,
	OpenRouterProviderAdapter,
	ReplicateProviderAdapter,
} from "../providers";
import type { ProviderExecutionInput } from "../types";
import {
	createImageEditBenchmarkPlan,
	imageEditBenchmarkRouteRef,
	parseImageEditBenchmarkCliArguments,
	resolveImageEditBenchmarkRoutes,
	runImageEditBenchmark,
	serializeImageEditBenchmarkReport,
	type ImageEditBenchmarkExecutor,
} from "./image-edit-benchmark";
import { buildImageEditBenchmarkScorecard } from "./scorecard";
import {
	parseImageEditBenchmarkManifest,
	parseImageEditBenchmarkObservation,
	type ImageEditBenchmarkManifest,
	type ImageEditBenchmarkObservation,
	type ImageEditBenchmarkResult,
} from "./types";

const manifestPath = fileURLToPath(
	new URL("../../../../fixtures/image-edit-benchmark/manifest.json", import.meta.url),
);
const mappingFixturePath = fileURLToPath(
	new URL(
		"../../../../fixtures/image-edit-benchmark/provider-request-mappings.json",
		import.meta.url,
	),
);

async function readJson(path: string): Promise<unknown> {
	return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function fixtureManifest(): Promise<ImageEditBenchmarkManifest> {
	return parseImageEditBenchmarkManifest(await readJson(manifestPath));
}

async function authorizedManifest(): Promise<ImageEditBenchmarkManifest> {
	const manifest = await fixtureManifest();
	return parseImageEditBenchmarkManifest({
		...manifest,
		images: manifest.images.map((image, index) => ({
			...image,
			source: {
				kind: "private-asset",
				assetId: `asset_benchmark${String(index + 1).padStart(8, "0")}`,
			},
			authorization: {
				status: "authorized",
				evidenceRef: `authorization-record-${index + 1}`,
			},
		})),
	});
}

function safeResult(overrides: Partial<ImageEditBenchmarkResult> = {}): ImageEditBenchmarkResult {
	return {
		status: "succeeded",
		firstResultUsable: true,
		scores: {
			subjectPreservation: 4,
			promptAdherence: 4,
			visualQuality: 4,
		},
		latencyMs: 1_000,
		providerCostMicros: 3_000,
		output: {
			count: 1,
			width: 1_024,
			height: 1_024,
			mimeTypes: ["image/png"],
		},
		privateTransfer: "stored",
		moderationDecision: "ALLOW",
		retries: 0,
		...overrides,
	};
}

describe("image edit benchmark manifest", () => {
	it("expresses a private placeholder dataset with ten inputs, three tasks each, and all required categories", async () => {
		const manifest = await fixtureManifest();
		const taskCount = manifest.images.reduce((sum, image) => sum + image.tasks.length, 0);

		expect(manifest.privacy).toBe("private");
		expect(manifest.images).toHaveLength(10);
		expect(manifest.images.every((image) => image.tasks.length >= 3)).toBe(true);
		expect(taskCount).toBe(30);
		expect(new Set(manifest.images.map((image) => image.category))).toEqual(
			new Set([
				"product-white-background",
				"portrait",
				"indoor",
				"outdoor",
				"complex-multi-object",
			]),
		);
		expect(manifest.images.every((image) => image.source.kind === "placeholder")).toBe(true);
		expect(manifest.images.every((image) => image.authorization.status === "pending")).toBe(true);
	});

	it("rejects manifests that cannot meet the ten-input, three-task, thirty-task contract", async () => {
		const manifest = await fixtureManifest();

		expect(() =>
			parseImageEditBenchmarkManifest({ ...manifest, images: manifest.images.slice(0, 9) }),
		).toThrow(/at least 10/i);
		expect(() =>
			parseImageEditBenchmarkManifest({
				...manifest,
				images: manifest.images.map((image, index) =>
					index === 0 ? { ...image, tasks: image.tasks.slice(0, 2) } : image,
				),
			}),
		).toThrow(/at least 3/i);
		expect(() =>
			parseImageEditBenchmarkManifest({
				...manifest,
				images: manifest.images.map((image) => ({
					...image,
					category: "portrait",
				})),
			}),
		).toThrow(/required categor/i);
		expect(() =>
			parseImageEditBenchmarkManifest({
				...manifest,
				images: manifest.images.map((image, index) =>
					index === 0
						? {
								...image,
								tasks: image.tasks.map((task) => ({
									...task,
									kind: "replace-background",
								})),
							}
						: image,
				),
			}),
		).toThrow(/at least 3 distinct task kinds/i);
		expect(() =>
			parseImageEditBenchmarkManifest({
				...manifest,
				images: manifest.images.map((image, index) =>
					index === 0
						? {
								...image,
								source: {
									kind: "private-asset",
									assetId: "asset_benchmark00000001",
									sourceUrl: "https://attacker.example/input.png",
								},
							}
						: image,
				),
			}),
		).toThrow();
	});

	it("accepts existing private MediaAsset identifiers without requiring an invented prefix", async () => {
		const manifest = await fixtureManifest();

		expect(() =>
			parseImageEditBenchmarkManifest({
				...manifest,
				images: manifest.images.map((image, index) => ({
					...image,
					source: {
						kind: "private-asset",
						assetId: `cm${String(index + 1).padStart(23, "0")}`,
					},
					authorization: {
						status: "authorized",
						evidenceRef: `authorization-record-${index + 1}`,
					},
				})),
			}),
		).not.toThrow();
	});
});

describe("image edit benchmark planning", () => {
	it("defaults to dry-run and resolves only the current image-edit catalog routes", () => {
		const options = parseImageEditBenchmarkCliArguments([], {});
		const routes = resolveImageEditBenchmarkRoutes();

		expect(options).toMatchObject({ mode: "dry-run", confirmSpend: false });
		expect(options.maxBudgetMicros).toBeUndefined();
		expect(routes.map(imageEditBenchmarkRouteRef)).toEqual([
			"image-fast:openrouter:sourceful/riverflow-v2.5-fast",
			"image-quality:openrouter:sourceful/riverflow-v2.5-pro",
		]);
		expect(
			routes.every((route) => ["image-fast", "image-quality"].includes(route.productKey)),
		).toBe(true);
	});

	it("selects exact Provider/model tuples and rejects anything outside the current catalog", () => {
		const selected = resolveImageEditBenchmarkRoutes([
			"image-quality:openrouter:sourceful/riverflow-v2.5-pro",
		]);

		expect(selected).toEqual([
			expect.objectContaining({
				productKey: "image-quality",
				provider: "openrouter",
				providerModelId: "sourceful/riverflow-v2.5-pro",
			}),
		]);
		expect(() =>
			resolveImageEditBenchmarkRoutes(["image-fast:replicate:black-forest-labs/flux-schnell"]),
		).toThrow(/not a current image-edit catalog route/i);
		expect(() => resolveImageEditBenchmarkRoutes(["video-fast:fal:fal-ai/fast-video"])).toThrow(
			/not a current image-edit catalog route/i,
		);
	});

	it("counts tasks, route invocations, and the catalog-cost ceiling before execution", async () => {
		const plan = createImageEditBenchmarkPlan(await fixtureManifest());

		expect(plan).toMatchObject({
			imageCount: 10,
			taskCount: 30,
			routeCount: 2,
			plannedInvocations: 60,
			maximumCatalogCostMicros: 6_090_000,
		});
		expect(plan.routes.map((route) => route.provider)).toEqual(["openrouter", "openrouter"]);
	});

	it("parses an explicit live budget and refuses zero, malformed, duplicate, or unknown arguments", () => {
		expect(
			parseImageEditBenchmarkCliArguments(
				[
					"--live",
					"--confirm-spend",
					"--max-budget-micros",
					"690000",
					"--route=image-fast:openrouter:sourceful/riverflow-v2.5-fast",
				],
				{},
			),
		).toMatchObject({
			mode: "live",
			confirmSpend: true,
			maxBudgetMicros: 690_000,
			routeSelectors: ["image-fast:openrouter:sourceful/riverflow-v2.5-fast"],
		});
		expect(() =>
			parseImageEditBenchmarkCliArguments(["--live", "--max-budget-micros=0"], {}),
		).toThrow(/positive integer/i);
		expect(() =>
			parseImageEditBenchmarkCliArguments(["--live", "--max-budget-micros=12.5"], {}),
		).toThrow(/positive integer/i);
		expect(() =>
			parseImageEditBenchmarkCliArguments(["--max-budget-micros=10", "--max-budget-micros=20"], {}),
		).toThrow(/only be provided once/i);
		expect(() => parseImageEditBenchmarkCliArguments(["--paid-maybe"], {})).toThrow(
			/unknown argument/i,
		);
	});
});

describe("image edit benchmark spend and privacy gates", () => {
	it("never invokes an executor when confirmation, positive budget, cost ceiling, or credentials fail", async () => {
		const manifest = await authorizedManifest();
		let calls = 0;
		const executeCase: ImageEditBenchmarkExecutor = async () => {
			calls += 1;
			return safeResult();
		};
		const base = {
			manifest,
			mode: "live" as const,
			routeSelectors: ["image-fast:openrouter:sourceful/riverflow-v2.5-fast"],
		};

		await expect(
			runImageEditBenchmark(
				{ ...base, maxBudgetMicros: 690_000 },
				{ executeCase, environment: { OPENROUTER_API_KEY: "test-only" } },
			),
		).rejects.toThrow(/--confirm-spend/i);
		await expect(
			runImageEditBenchmark(
				{ ...base, confirmSpend: true },
				{ executeCase, environment: { OPENROUTER_API_KEY: "test-only" } },
			),
		).rejects.toThrow(/positive --max-budget-micros/i);
		await expect(
			runImageEditBenchmark(
				{ ...base, confirmSpend: true, maxBudgetMicros: 689_999 },
				{ executeCase, environment: { OPENROUTER_API_KEY: "test-only" } },
			),
		).rejects.toThrow(/exceeds.*budget/i);
		await expect(
			runImageEditBenchmark(
				{ ...base, confirmSpend: true, maxBudgetMicros: 690_000 },
				{ executeCase, environment: {} },
			),
		).rejects.toThrow(/OPENROUTER_API_KEY.*before any Provider call/i);

		expect(calls).toBe(0);
	});

	it("rejects placeholder or unauthorized inputs before credentials or execution are consulted", async () => {
		let calls = 0;
		const executeCase: ImageEditBenchmarkExecutor = async () => {
			calls += 1;
			return safeResult();
		};

		await expect(
			runImageEditBenchmark(
				{
					manifest: await fixtureManifest(),
					mode: "live",
					confirmSpend: true,
					maxBudgetMicros: 690_000,
					routeSelectors: ["image-fast:openrouter:sourceful/riverflow-v2.5-fast"],
				},
				{ executeCase, environment: {} },
			),
		).rejects.toThrow(/authorized private asset/i);
		expect(calls).toBe(0);
	});

	it("requires the private production pipeline executor even after all spend and credential gates pass", async () => {
		await expect(
			runImageEditBenchmark(
				{
					manifest: await authorizedManifest(),
					mode: "live",
					confirmSpend: true,
					maxBudgetMicros: 690_000,
					routeSelectors: ["image-fast:openrouter:sourceful/riverflow-v2.5-fast"],
				},
				{ environment: { OPENROUTER_API_KEY: "test-only" } },
			),
		).rejects.toThrow(/private production pipeline executor/i);
	});

	it("executes the exact bounded case count through an injected private pipeline", async () => {
		const seen: Parameters<ImageEditBenchmarkExecutor>[0][] = [];
		const executeCase: ImageEditBenchmarkExecutor = async (input) => {
			seen.push(input);
			return safeResult();
		};
		const report = await runImageEditBenchmark(
			{
				manifest: await authorizedManifest(),
				mode: "live",
				confirmSpend: true,
				maxBudgetMicros: 690_000,
				routeSelectors: ["image-fast:openrouter:sourceful/riverflow-v2.5-fast"],
			},
			{
				executeCase,
				environment: { OPENROUTER_API_KEY: "test-only" },
				now: () => new Date("2026-08-25T00:00:00.000Z"),
			},
		);

		expect(seen).toHaveLength(30);
		expect(new Set(seen.map((input) => input.route.provider))).toEqual(new Set(["openrouter"]));
		expect(seen.every((input) => input.sourceAssetId.startsWith("asset_benchmark"))).toBe(true);
		expect(report).toMatchObject({
			status: "EXECUTION_RECORDED_NOT_CERTIFIED",
			plan: { plannedInvocations: 30, maximumCatalogCostMicros: 690_000 },
		});
	});

	it("rechecks the remaining catalog ceiling before every Provider call", async () => {
		let calls = 0;
		const executeCase: ImageEditBenchmarkExecutor = async () => {
			calls += 1;
			return safeResult({ providerCostMicros: 24_000 });
		};

		await expect(
			runImageEditBenchmark(
				{
					manifest: await authorizedManifest(),
					mode: "live",
					confirmSpend: true,
					maxBudgetMicros: 690_000,
					routeSelectors: ["image-fast:openrouter:sourceful/riverflow-v2.5-fast"],
				},
				{
					executeCase,
					environment: { OPENROUTER_API_KEY: "test-only" },
				},
			),
		).rejects.toThrow(/remaining catalog cost ceiling.*before the next Provider call/i);
		expect(calls).toBe(1);
	});

	it("stops after one Provider call when its observed cost is unavailable", async () => {
		let calls = 0;
		const executeCase: ImageEditBenchmarkExecutor = async () => {
			calls += 1;
			return safeResult({ providerCostMicros: null });
		};

		await expect(
			runImageEditBenchmark(
				{
					manifest: await authorizedManifest(),
					mode: "live",
					confirmSpend: true,
					maxBudgetMicros: 690_000,
					routeSelectors: ["image-fast:openrouter:sourceful/riverflow-v2.5-fast"],
				},
				{
					executeCase,
					environment: { OPENROUTER_API_KEY: "test-only" },
				},
			),
		).rejects.toThrow(/observed Provider cost is unavailable.*no further calls/i);
		expect(calls).toBe(1);
	});

	it("rejects an executor result that bypasses private transfer or output moderation", async () => {
		const executeCase: ImageEditBenchmarkExecutor = async () =>
			safeResult({ privateTransfer: "not-stored" });

		await expect(
			runImageEditBenchmark(
				{
					manifest: await authorizedManifest(),
					mode: "live",
					confirmSpend: true,
					maxBudgetMicros: 690_000,
					routeSelectors: ["image-fast:openrouter:sourceful/riverflow-v2.5-fast"],
				},
				{
					executeCase,
					environment: { OPENROUTER_API_KEY: "test-only" },
				},
			),
		).rejects.toThrow(/private transfer.*moderation/i);
	});
});

describe("image edit benchmark scorecard and report", () => {
	it("keeps every real metric and both route decisions NOT_COMPLETED in dry-run", async () => {
		const manifest = await fixtureManifest();
		const report = await runImageEditBenchmark(
			{ manifest, mode: "dry-run" },
			{ now: () => new Date("2026-08-25T00:00:00.000Z") },
		);
		const serialized = serializeImageEditBenchmarkReport(report);

		expect(report.status).toBe("DRY_RUN_ONLY");
		expect(report.scorecard.routes).toHaveLength(2);
		for (const route of report.scorecard.routes) {
			expect(route.successRate.status).toBe("NOT_COMPLETED");
			expect(route.firstResultUsableRate.status).toBe("NOT_COMPLETED");
			expect(route.latencyP50Ms.status).toBe("NOT_COMPLETED");
			expect(route.latencyP95Ms.status).toBe("NOT_COMPLETED");
			expect(route.providerCostMicros.status).toBe("NOT_COMPLETED");
		}
		expect(report.routeDecisions).toEqual({
			standard: expect.objectContaining({ status: "NOT_COMPLETED", selectedRoute: null }),
			quality: expect.objectContaining({ status: "NOT_COMPLETED", selectedRoute: null }),
		});
		expect(serialized).not.toContain(manifest.images[0]!.tasks[0]!.prompt);
		expect(serialized).not.toContain(manifest.images[0]!.id);
		expect(serialized).not.toMatch(/sourceAssetId|outputUrl|signedUrl|placeholderId/i);
		expect(serialized).toContain("PRIVATE_NOT_INCLUDED");
	});

	it("aggregates complete route observations with hand-derived rates, percentiles, costs, and scores", () => {
		const route = resolveImageEditBenchmarkRoutes([
			"image-fast:openrouter:sourceful/riverflow-v2.5-fast",
		])[0]!;
		const observations: ImageEditBenchmarkObservation[] = [100, 200, 300, 400].map(
			(latencyMs, index) =>
				parseImageEditBenchmarkObservation({
					caseId: `case-${index + 1}`,
					route,
					...safeResult({
						latencyMs,
						firstResultUsable: index < 3,
						scores: {
							subjectPreservation: 4,
							promptAdherence: 3,
							visualQuality: 5,
						},
					}),
				}),
		);
		observations.push(
			parseImageEditBenchmarkObservation({
				caseId: "case-5",
				route,
				status: "provider-rejected",
				firstResultUsable: false,
				scores: {
					subjectPreservation: null,
					promptAdherence: null,
					visualQuality: null,
				},
				latencyMs: 500,
				providerCostMicros: 0,
				privateTransfer: "not-applicable",
				moderationDecision: "NOT_RUN",
				retries: 2,
				failureCode: "PROVIDER_REJECTED",
			}),
		);

		const scorecard = buildImageEditBenchmarkScorecard(
			[{ route, plannedInvocations: 5 }],
			observations,
		);
		const summary = scorecard.routes[0]!;

		expect(summary.observedInvocations).toBe(5);
		expect(summary.successRate).toEqual({ status: "MEASURED", value: 0.8 });
		expect(summary.firstResultUsableRate).toEqual({ status: "MEASURED", value: 0.6 });
		expect(summary.latencyP50Ms).toEqual({ status: "MEASURED", value: 200 });
		expect(summary.latencyP95Ms).toEqual({ status: "MEASURED", value: 400 });
		expect(summary.providerCostMicros).toEqual({ status: "MEASURED", value: 12_000 });
		expect(summary.averageScores).toEqual({
			status: "MEASURED",
			value: { subjectPreservation: 4, promptAdherence: 3, visualQuality: 5 },
		});
		expect(summary.outputSummary).toEqual({
			status: "MEASURED",
			value: {
				outputCount: 4,
				mimeTypes: { "image/png": 4 },
				dimensions: { "1024x1024": 4 },
			},
		});
		expect(summary.providerRejections).toBe(1);
		expect(summary.retryCount).toBe(2);
	});

	it("rejects output URLs, non-image MIME types, and successful results without private approved outputs", () => {
		const route = resolveImageEditBenchmarkRoutes()[0]!;
		const base = { caseId: "case-1", route, ...safeResult() };

		expect(() =>
			parseImageEditBenchmarkObservation({
				...base,
				outputUrl: "https://provider.example/private-output.png",
			}),
		).toThrow();
		expect(() =>
			parseImageEditBenchmarkObservation({
				...base,
				output: { ...base.output, mimeTypes: ["video/mp4"] },
			}),
		).toThrow(/MIME|mime/i);
		expect(() =>
			parseImageEditBenchmarkObservation({
				...base,
				output: {
					count: 5,
					width: 1_024,
					height: 1_024,
					mimeTypes: Array.from({ length: 5 }, () => "image/png"),
				},
			}),
		).toThrow();
		expect(() =>
			parseImageEditBenchmarkObservation({
				...base,
				moderationDecision: "REVIEW",
			}),
		).toThrow(/private transfer.*moderation/i);
	});
});

describe("image edit Provider request mapping fixtures", () => {
	it("keeps retained adapter mappings server-owned without treating every adapter as a catalog route", async () => {
		const fixture = (await readJson(mappingFixturePath)) as {
			source: {
				assetId: string;
				httpsTransferUrl: string;
				inlineDataUrl: string;
			};
			expected: { replicate: unknown; fal: unknown; gemini: unknown; openrouter: unknown };
		};
		const captures: Record<string, unknown> = {};
		const capturingFetch =
			(provider: string, responseBody: unknown): typeof fetch =>
			async (_input, init) => {
				if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
				captures[provider] = JSON.parse(init.body) as unknown;
				return new Response(JSON.stringify(responseBody), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			};
		const httpsInput: ProviderExecutionInput = {
			kind: "image-to-image",
			prompt: "Preserve the subject and replace the background",
			strength: 0.6,
			sourceAsset: {
				assetId: fixture.source.assetId,
				transferUrl: fixture.source.httpsTransferUrl,
			},
		};
		const inlineInput: ProviderExecutionInput = {
			...httpsInput,
			sourceAsset: {
				assetId: fixture.source.assetId,
				transferUrl: fixture.source.inlineDataUrl,
			},
		};

		await new ReplicateProviderAdapter({
			apiToken: "test-only",
			fetch: capturingFetch("replicate", { id: "replicate-1", status: "starting" }),
		}).submit({
			attemptId: "attempt-replicate",
			providerModelId: "black-forest-labs/flux-schnell",
			input: httpsInput,
		});
		await new FalProviderAdapter({
			apiKey: "test-only",
			fetch: capturingFetch("fal", { request_id: "fal-1", status: "IN_QUEUE" }),
		}).submit({
			attemptId: "attempt-fal",
			providerModelId: "fal-ai/flux/schnell",
			input: httpsInput,
		});
		await new GeminiProviderAdapter({
			apiKey: "test-only",
			fetch: capturingFetch("gemini", {
				candidates: [
					{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "aA==" } }] } },
				],
			}),
		}).submit({
			attemptId: "attempt-gemini",
			providerModelId: "gemini-2.5-flash-image",
			input: inlineInput,
		});
		await new OpenRouterProviderAdapter({
			apiKey: "test-only",
			fetch: capturingFetch("openrouter", { data: [{ b64_json: "iVBORw0KGgo=" }] }),
		}).submit({
			attemptId: "attempt-openrouter",
			providerModelId: "sourceful/riverflow-v2.5-fast",
			input: httpsInput,
		});

		expect(captures.replicate).toEqual(fixture.expected.replicate);
		expect(captures.fal).toEqual(fixture.expected.fal);
		expect(captures.gemini).toEqual(fixture.expected.gemini);
		expect(captures.openrouter).toEqual(fixture.expected.openrouter);
	});
});
