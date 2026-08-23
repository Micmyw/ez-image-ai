import type { MediaProviderAdapter, ProviderKey, VerifiedProviderEvent } from "@repo/ai";

const WEBHOOK_PROVIDERS = new Set<ProviderKey>(["replicate"]);

export interface ProviderWebhookPersistenceInput {
	provider: ProviderKey;
	event: VerifiedProviderEvent;
	envelope: unknown;
}

export interface ProviderWebhookHandlerDependencies {
	getVerifier(provider: ProviderKey): Pick<MediaProviderAdapter, "verifyWebhook"> | null;
	persist(input: ProviderWebhookPersistenceInput): Promise<{
		replayed: boolean;
		eventId: string;
	}>;
	deliver?(payload: { providerWebhookEventId: string }): Promise<void>;
}

export function createProviderWebhookHandler(dependencies: ProviderWebhookHandlerDependencies) {
	return async function handleProviderWebhook(
		providerValue: string,
		request: Request,
	): Promise<Response> {
		if (!isProviderKey(providerValue) || !WEBHOOK_PROVIDERS.has(providerValue)) {
			return jsonResponse(404, { code: "WEBHOOK_NOT_SUPPORTED" });
		}
		const verifier = dependencies.getVerifier(providerValue);
		if (!verifier?.verifyWebhook) {
			return jsonResponse(404, { code: "WEBHOOK_NOT_SUPPORTED" });
		}
		const raw = await request.arrayBuffer();
		const verificationRequest = new Request(request.url, {
			method: request.method,
			headers: request.headers,
			body: raw,
		});
		let event: VerifiedProviderEvent;
		try {
			event = await verifier.verifyWebhook(verificationRequest);
		} catch {
			return jsonResponse(401, { code: "WEBHOOK_VERIFICATION_FAILED" });
		}
		let envelope: unknown;
		try {
			envelope = JSON.parse(new TextDecoder().decode(raw));
		} catch {
			return jsonResponse(400, { code: "WEBHOOK_INVALID" });
		}
		const persisted = await dependencies.persist({ provider: providerValue, event, envelope });
		if (!persisted.replayed && dependencies.deliver) {
			void dependencies
				.deliver({ providerWebhookEventId: persisted.eventId })
				.catch(() => undefined);
		}
		return jsonResponse(202, { accepted: true, replayed: persisted.replayed });
	};
}

function isProviderKey(value: string): value is ProviderKey {
	return value === "replicate" || value === "fal" || value === "kie" || value === "gemini";
}

function jsonResponse(status: number, body: unknown): Response {
	return Response.json(body, { status });
}
