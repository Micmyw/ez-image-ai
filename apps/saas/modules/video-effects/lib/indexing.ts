import { publicPageIndexing, type PublicSearchParams } from "../../public-content/lib/indexing";

/** Public landing-page discovery does not certify reviewed video sample publication. */
export function videoEffectMayIndex(publicPage: boolean, search: PublicSearchParams) {
	return publicPage && publicPageIndexing("/video-effects/hotel-lobby-ai", search).index;
}
