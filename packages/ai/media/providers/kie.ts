import type { ImageBackground, ImageOutputFormat, ImageSkuKey } from "@repo/config";
import { z } from "zod";

import { MediaProviderError } from "../errors";
import type {
	NormalizedResult,
	ProviderRetrieveInput,
	ProviderSubmission,
	ProviderSubmitInput,
	ProviderTaskSnapshot,
} from "../types";
import { failureFrom, normalizedResult, remoteOutputs } from "./common";
import { fetchJson, rejectedHttpSubmission, type HttpClientOptions } from "./http";
import type { MediaProviderAdapter } from "./provider-adapter";

const kieCreateEnvelopeSchema = z.object({
	code: z.number(),
	msg: z.string().optional(),
	data: z.unknown().nullish(),
});

const kieCreateSuccessDataSchema = z.object({ taskId: z.string().min(1) });

const kieVeoRecordSchema = z.object({
	code: z.number().optional(),
	msg: z.string().optional(),
	data: z.object({
		taskId: z.string().min(1),
		successFlag: z.number().int(),
		response: z
			.object({
				resultUrls: z.array(z.string()).optional(),
				fullResultUrls: z.array(z.string()).optional(),
			})
			.nullish(),
		errorMessage: z.string().nullish(),
	}),
});

const kieLegacyRecordSchema = z.object({
	data: z.object({
		taskId: z.string().min(1),
		state: z.string(),
		resultUrls: z.array(z.string()).optional(),
		failMsg: z.string().optional(),
		progress: z.number().optional(),
	}),
});

const kieJobRecordSchema = z.object({
	code: z.literal(200),
	msg: z.string().optional(),
	data: z
		.object({
			taskId: z.string().min(1),
			state: z.string(),
			resultJson: z.string().nullish(),
			failCode: z.union([z.string(), z.number()]).nullish(),
			failMsg: z.string().nullish(),
			creditsConsumed: z.number().nonnegative().finite().max(Number.MAX_SAFE_INTEGER).nullish(),
		})
		.passthrough(),
});

const kieJobResultSchema = z
	.object({ resultUrls: z.array(z.string().min(1)).optional() })
	.passthrough();

const KIE_CREDIT_COST_MICROS = 5_000;

export interface KieProviderOptions extends HttpClientOptions {
	apiKey: string;
	baseUrl?: string;
}

export class KieProviderAdapter implements MediaProviderAdapter {
	readonly provider = "kie" as const;
	constructor(private readonly options: KieProviderOptions) {}

	async submit(input: ProviderSubmitInput): Promise<ProviderSubmission> {
		const isImageJob = input.input.kind === "image-to-image";
		const request = isImageJob
			? {
					path: "/api/v1/jobs/createTask",
					body: buildKieImageRequest(input),
				}
			: {
					path: "/api/v1/veo/generate",
					body: buildKieVeoRequest(input),
				};
		const { ok, status, data } = await fetchJson(
			`${this.baseUrl()}${request.path}`,
			{
				method: "POST",
				headers: this.headers(),
				body: JSON.stringify(request.body),
			},
			this.options,
		);
		if (!ok)
			return rejectedHttpSubmission({
				status,
				data,
				attemptId: input.attemptId,
				providerIdempotencySupported: false,
			});
		const envelope = kieCreateEnvelopeSchema.safeParse(data);
		if (!envelope.success) throw malformedKieResponse();
		if (envelope.data.code !== 200) {
			return rejectedHttpSubmission({
				status: providerCodeStatus(envelope.data.code),
				data: envelope.data.msg,
				attemptId: input.attemptId,
				providerIdempotencySupported: false,
			});
		}
		const successData = kieCreateSuccessDataSchema.safeParse(envelope.data.data);
		if (!successData.success) throw malformedKieResponse();
		const snapshot: ProviderTaskSnapshot = {
			providerTaskId: successData.data.taskId,
			status: "QUEUED",
			raw: envelope.data,
		};
		const statusUrl = isImageJob ? this.jobStatusUrl(snapshot.providerTaskId) : undefined;
		return {
			providerTaskId: snapshot.providerTaskId,
			status: snapshot.status,
			outcome: "accepted",
			idempotency: { providerSupported: false, replayed: false },
			reconciliation: {
				submissionToken: input.attemptId,
				...(statusUrl ? { statusUrl } : {}),
			},
			snapshot,
		};
	}

	async retrieve(input: ProviderRetrieveInput): Promise<ProviderTaskSnapshot> {
		const expectedJobStatusUrl = this.jobStatusUrl(input.providerTaskId);
		if (input.statusUrl !== undefined && input.statusUrl !== expectedJobStatusUrl) {
			throw new MediaProviderError(
				"MALFORMED_PROVIDER_RESPONSE",
				"Kie status URL was not server-derived",
				false,
			);
		}
		const retrievalUrl =
			input.statusUrl ??
			`${this.baseUrl()}/api/v1/veo/record-info?taskId=${encodeURIComponent(input.providerTaskId)}`;
		const { ok, data } = await fetchJson(retrievalUrl, { headers: this.headers() }, this.options);
		if (!ok) return { providerTaskId: input.providerTaskId, status: "UNKNOWN", raw: data };
		if (input.statusUrl !== undefined) {
			const job = kieJobRecordSchema.safeParse(data);
			if (!job.success || job.data.data.taskId !== input.providerTaskId) {
				throw malformedKieResponse();
			}
			return {
				providerTaskId: job.data.data.taskId,
				status: jobStatus(job.data.data.state),
				raw: job.data,
			};
		}
		const veo = kieVeoRecordSchema.safeParse(data);
		if (veo.success) {
			return {
				providerTaskId: veo.data.data.taskId,
				status: statusFromSuccessFlag(veo.data.data.successFlag),
				raw: veo.data,
			};
		}
		const legacy = kieLegacyRecordSchema.safeParse(data);
		if (!legacy.success) throw malformedKieResponse();
		return {
			providerTaskId: legacy.data.data.taskId,
			status: legacyStatus(legacy.data.data.state),
			progress: legacy.data.data.progress,
			raw: legacy.data,
		};
	}

	async normalizeResult(snapshot: ProviderTaskSnapshot): Promise<NormalizedResult> {
		const job = kieJobRecordSchema.safeParse(snapshot.raw);
		if (job.success) {
			const providerCostMicros = jobCostMicros(job.data.data.creditsConsumed);
			const result = normalizedResult(
				snapshot,
				remoteOutputs(jobResultUrls(job.data.data.resultJson)),
				failureFrom(jobFailureMessage(job.data.data.failCode, job.data.data.failMsg)),
				providerCostMicros,
			);
			return {
				...result,
				providerCharged:
					snapshot.status === "SUCCEEDED" ||
					(providerCostMicros !== null && providerCostMicros > 0),
			};
		}
		const veo = kieVeoRecordSchema.safeParse(snapshot.raw);
		if (veo.success) {
			const response = veo.data.data.response;
			const urls = response?.fullResultUrls?.length
				? response.fullResultUrls
				: (response?.resultUrls ?? []);
			return normalizedResult(
				snapshot,
				remoteOutputs(urls),
				failureFrom(veo.data.data.errorMessage || undefined),
				null,
			);
		}
		const legacy = kieLegacyRecordSchema.safeParse(snapshot.raw);
		if (!legacy.success) throw malformedKieResponse();
		return normalizedResult(
			snapshot,
			remoteOutputs(legacy.data.data.resultUrls ?? []),
			failureFrom(legacy.data.data.failMsg),
			null,
		);
	}

	private baseUrl(): string {
		return this.options.baseUrl ?? "https://api.kie.ai";
	}

	private jobStatusUrl(providerTaskId: string): string {
		return `${this.baseUrl()}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`;
	}

	private headers(): Record<string, string> {
		return {
			Authorization: `Bearer ${this.options.apiKey}`,
			"Content-Type": "application/json",
		};
	}
}

function buildKieImageRequest(input: ProviderSubmitInput): Record<string, unknown> {
	if (input.input.kind !== "image-to-image") throw unsupportedKieInput();
	const aspectRatio = input.input.aspectRatio;
	if (!aspectRatio) throw unsupportedKieInput();
	const skuKey = input.input.skuKey;
	if (!skuKey) throw unsupportedKieInput();
	const spec: KieImageRequestSpec = KIE_IMAGE_REQUEST_SPECS[skuKey];
	if (spec.providerModelId !== input.providerModelId) throw unsupportedKieInput();
	const parameters: Record<string, string | boolean> = { ...spec.parameters };
	if (input.input.outputFormat !== undefined) {
		const outputFormat = spec.outputFormats?.[input.input.outputFormat];
		if (!outputFormat) throw unsupportedKieInput();
		parameters.output_format = outputFormat;
	}
	if (input.input.background !== undefined) {
		const background = spec.backgrounds?.[input.input.background];
		if (!background) throw unsupportedKieInput();
		parameters.background = background;
	}
	return {
		model: input.providerModelId,
		input: {
			[spec.sourceField]: [input.input.sourceAsset.transferUrl],
			prompt: input.input.prompt,
			aspect_ratio: aspectRatio,
			...parameters,
		},
	};
}

interface KieImageRequestSpec {
	providerModelId: string;
	sourceField: "image_urls" | "image_input" | "input_urls";
	parameters: Readonly<Record<string, string | boolean>>;
	outputFormats?: Readonly<Partial<Record<ImageOutputFormat, string>>>;
	backgrounds?: Readonly<Partial<Record<ImageBackground, string>>>;
}

const KIE_IMAGE_REQUEST_SPECS = {
	"nano-banana-2-lite-1k": {
		providerModelId: "nano-banana-2-lite",
		sourceField: "image_urls",
		parameters: {},
	},
	"nano-banana-default": {
		providerModelId: "google/nano-banana-edit",
		sourceField: "image_urls",
		parameters: { output_format: "png", nsfw_checker: true },
		outputFormats: { png: "png", jpeg: "jpeg" },
	},
	"nano-banana-2-1k": {
		providerModelId: "nano-banana-2",
		sourceField: "image_input",
		parameters: { resolution: "1K", output_format: "jpg" },
		outputFormats: { png: "png", jpeg: "jpg" },
	},
	"nano-banana-2-2k": {
		providerModelId: "nano-banana-2",
		sourceField: "image_input",
		parameters: { resolution: "2K", output_format: "jpg" },
		outputFormats: { png: "png", jpeg: "jpg" },
	},
	"nano-banana-2-4k": {
		providerModelId: "nano-banana-2",
		sourceField: "image_input",
		parameters: { resolution: "4K", output_format: "jpg" },
		outputFormats: { png: "png", jpeg: "jpg" },
	},
	"nano-banana-pro-1k": {
		providerModelId: "nano-banana-pro",
		sourceField: "image_input",
		parameters: { resolution: "1K", output_format: "png" },
		outputFormats: { png: "png", jpeg: "jpg" },
	},
	"nano-banana-pro-2k": {
		providerModelId: "nano-banana-pro",
		sourceField: "image_input",
		parameters: { resolution: "2K", output_format: "png" },
		outputFormats: { png: "png", jpeg: "jpg" },
	},
	"nano-banana-pro-4k": {
		providerModelId: "nano-banana-pro",
		sourceField: "image_input",
		parameters: { resolution: "4K", output_format: "png" },
		outputFormats: { png: "png", jpeg: "jpg" },
	},
	"gpt-image-1-5-medium": {
		providerModelId: "gpt-image/1.5-image-to-image",
		sourceField: "input_urls",
		parameters: { quality: "medium" },
	},
	"gpt-image-1-5-high": {
		providerModelId: "gpt-image/1.5-image-to-image",
		sourceField: "input_urls",
		parameters: { quality: "high" },
	},
	"gpt-image-2-1k": {
		providerModelId: "gpt-image-2-image-to-image",
		sourceField: "input_urls",
		parameters: { resolution: "1K", background: "opaque" },
		backgrounds: { auto: "auto", opaque: "opaque", transparent: "transparent" },
	},
	"gpt-image-2-2k": {
		providerModelId: "gpt-image-2-image-to-image",
		sourceField: "input_urls",
		parameters: { resolution: "2K" },
	},
	"gpt-image-2-4k": {
		providerModelId: "gpt-image-2-image-to-image",
		sourceField: "input_urls",
		parameters: { resolution: "4K" },
	},
	"seedream-4-5-basic-2k": {
		providerModelId: "seedream/4.5-edit",
		sourceField: "image_urls",
		parameters: { quality: "basic", nsfw_checker: true },
	},
	"seedream-4-5-high-4k": {
		providerModelId: "seedream/4.5-edit",
		sourceField: "image_urls",
		parameters: { quality: "high", nsfw_checker: true },
	},
	"seedream-5-lite-basic-2k": {
		providerModelId: "seedream/5-lite-image-to-image",
		sourceField: "image_urls",
		parameters: { quality: "basic", output_format: "png", nsfw_checker: true },
		outputFormats: { png: "png", jpeg: "jpeg" },
	},
	"seedream-5-lite-high-3k": {
		providerModelId: "seedream/5-lite-image-to-image",
		sourceField: "image_urls",
		parameters: { quality: "high", output_format: "png", nsfw_checker: true },
		outputFormats: { png: "png", jpeg: "jpeg" },
	},
	"seedream-5-lite-ultra-4k": {
		providerModelId: "seedream/5-lite-image-to-image",
		sourceField: "image_urls",
		parameters: { quality: "ultra", output_format: "png", nsfw_checker: true },
		outputFormats: { png: "png", jpeg: "jpeg" },
	},
	"seedream-5-pro-basic-1k": {
		providerModelId: "seedream/5-pro-image-to-image",
		sourceField: "image_urls",
		parameters: { quality: "basic", output_format: "png", nsfw_checker: true },
		outputFormats: { png: "png", jpeg: "jpeg" },
	},
	"seedream-5-pro-high-2k": {
		providerModelId: "seedream/5-pro-image-to-image",
		sourceField: "image_urls",
		parameters: { quality: "high", output_format: "png", nsfw_checker: true },
		outputFormats: { png: "png", jpeg: "jpeg" },
	},
} as const satisfies Record<ImageSkuKey, KieImageRequestSpec>;

function buildKieVeoRequest(input: ProviderSubmitInput): Record<string, unknown> {
	if (
		"durationSeconds" in input.input &&
		input.input.durationSeconds !== undefined &&
		![4, 6, 8].includes(input.input.durationSeconds)
	) {
		throw new MediaProviderError(
			"MALFORMED_PROVIDER_RESPONSE",
			"Kie Veo duration must be 4, 6, or 8 seconds",
			false,
		);
	}
	return {
		model: input.providerModelId,
		prompt: input.input.prompt,
		...("sourceAsset" in input.input ? { imageUrls: [input.input.sourceAsset.transferUrl] } : {}),
		...("durationSeconds" in input.input ? { duration: input.input.durationSeconds } : {}),
	};
}

function unsupportedKieInput(): MediaProviderError {
	return new MediaProviderError(
		"UNSUPPORTED_INPUT",
		"Kie route input did not match a server-approved model and SKU",
		false,
	);
}

function jobStatus(value: string): ProviderTaskSnapshot["status"] {
	switch (value.toLowerCase()) {
		case "waiting":
		case "queuing":
			return "QUEUED";
		case "generating":
			return "RUNNING";
		case "success":
			return "SUCCEEDED";
		case "fail":
			return "FAILED";
		default:
			return "UNKNOWN";
	}
}

function jobResultUrls(value: string | null | undefined): string[] {
	if (!value) return [];
	try {
		const parsed = kieJobResultSchema.safeParse(JSON.parse(value) as unknown);
		if (!parsed.success) throw malformedKieResponse();
		const resultUrls = parsed.data.resultUrls ?? [];
		// Every current EzPic image SKU freezes exactly one output. More URLs make
		// the Provider result ambiguous, so retain the reservation for reconciliation
		// instead of silently delivering additional images under one SKU charge.
		if (resultUrls.length > 1) throw malformedKieResponse();
		return resultUrls;
	} catch (error) {
		if (error instanceof MediaProviderError) throw error;
		throw malformedKieResponse();
	}
}

function jobFailureMessage(
	failCode: string | number | null | undefined,
	failMsg: string | null | undefined,
): string | undefined {
	return (
		failMsg?.trim() || (failCode === null || failCode === undefined ? undefined : String(failCode))
	);
}

function jobCostMicros(creditsConsumed: number | null | undefined): number | null {
	if (creditsConsumed === null || creditsConsumed === undefined) return null;
	const cost = creditsConsumed * KIE_CREDIT_COST_MICROS;
	if (!Number.isSafeInteger(cost)) throw malformedKieResponse();
	return cost;
}

function statusFromSuccessFlag(value: number): ProviderTaskSnapshot["status"] {
	if (value === 0) return "RUNNING";
	if (value === 1) return "SUCCEEDED";
	if (value === 2 || value === 3) return "FAILED";
	return "UNKNOWN";
}

function legacyStatus(value: string): ProviderTaskSnapshot["status"] {
	const normalized = value.toLowerCase();
	if (["starting", "pending", "queued", "waiting"].includes(normalized)) return "QUEUED";
	if (["processing", "running"].includes(normalized)) return "RUNNING";
	if (["success", "succeeded", "completed"].includes(normalized)) return "SUCCEEDED";
	if (["failed", "error"].includes(normalized)) return "FAILED";
	if (["canceled", "cancelled"].includes(normalized)) return "CANCELED";
	return "UNKNOWN";
}

function providerCodeStatus(code: number): number {
	return code >= 400 && code <= 599 ? code : 500;
}

function malformedKieResponse(): MediaProviderError {
	return new MediaProviderError("MALFORMED_PROVIDER_RESPONSE", "Kie response was malformed", false);
}
