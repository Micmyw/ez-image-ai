import type {
	NormalizedResult,
	ProviderCancelInput,
	ProviderCancelResult,
	ProviderRetrieveInput,
	ProviderSubmission,
	ProviderSubmitInput,
	ProviderTaskSnapshot,
	ProviderKey,
	VerifiedProviderEvent,
} from "../types";

export interface MediaProviderAdapter {
	readonly provider: ProviderKey;
	submit(input: ProviderSubmitInput): Promise<ProviderSubmission>;
	retrieve(input: ProviderRetrieveInput): Promise<ProviderTaskSnapshot>;
	cancel?(input: ProviderCancelInput): Promise<ProviderCancelResult>;
	verifyWebhook?(request: Request): Promise<VerifiedProviderEvent>;
	normalizeResult(snapshot: ProviderTaskSnapshot): Promise<NormalizedResult>;
}

export interface RetrieveOnlyMediaProviderAdapter extends Omit<MediaProviderAdapter, "submit"> {
	submit?: never;
}
