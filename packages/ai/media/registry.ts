import type {
	MediaProviderAdapter,
	RetrieveOnlyMediaProviderAdapter,
} from "./providers/provider-adapter";
import type { ProviderKey } from "./types";

export class MediaProviderRegistry {
	private readonly providers = new Map<
		ProviderKey,
		MediaProviderAdapter | RetrieveOnlyMediaProviderAdapter
	>();
	register(adapter: MediaProviderAdapter | RetrieveOnlyMediaProviderAdapter): void {
		this.providers.set(adapter.provider, adapter);
	}
	get(provider: ProviderKey): MediaProviderAdapter | RetrieveOnlyMediaProviderAdapter {
		const adapter = this.providers.get(provider);
		if (!adapter) throw new Error(`Media provider ${provider} is not registered`);
		return adapter;
	}
	keys(): IterableIterator<ProviderKey> {
		return this.providers.keys();
	}
}
