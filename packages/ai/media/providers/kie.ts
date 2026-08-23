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
	code: z.number().optional(),
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

export interface KieProviderOptions extends HttpClientOptions {
	apiKey: string;
	baseUrl?: string;
}

export class KieProviderAdapter implements MediaProviderAdapter {
	readonly provider = "kie" as const;
	constructor(private readonly options: KieProviderOptions) {}

	async submit(input: ProviderSubmitInput): Promise<ProviderSubmission> {
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
		const { ok, status, data } = await fetchJson(
			`${this.baseUrl()}/api/v1/veo/generate`,
			{
				method: "POST",
				headers: this.headers(),
				body: JSON.stringify({
					model: input.providerModelId,
					prompt: input.input.prompt,
					...("sourceAsset" in input.input
						? { imageUrls: [input.input.sourceAsset.transferUrl] }
						: {}),
					...("durationSeconds" in input.input ? { duration: input.input.durationSeconds } : {}),
				}),
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
		if (envelope.data.code !== undefined && envelope.data.code !== 200) {
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
		return {
			providerTaskId: snapshot.providerTaskId,
			status: snapshot.status,
			outcome: "accepted",
			idempotency: { providerSupported: false, replayed: false },
			reconciliation: { submissionToken: input.attemptId },
			snapshot,
		};
	}

	async retrieve(input: ProviderRetrieveInput): Promise<ProviderTaskSnapshot> {
		const { ok, data } = await fetchJson(
			`${this.baseUrl()}/api/v1/veo/record-info?taskId=${encodeURIComponent(input.providerTaskId)}`,
			{ headers: this.headers() },
			this.options,
		);
		if (!ok) return { providerTaskId: input.providerTaskId, status: "UNKNOWN", raw: data };
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

	private headers(): Record<string, string> {
		return {
			Authorization: `Bearer ${this.options.apiKey}`,
			"Content-Type": "application/json",
		};
	}
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
