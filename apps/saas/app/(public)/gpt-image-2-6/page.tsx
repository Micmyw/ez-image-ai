import { permanentRedirect } from "next/navigation";

import type { PublicMetadataProps } from "../../../modules/public-content/lib/indexing";

export default async function Page({ searchParams }: PublicMetadataProps) {
	const search = (await searchParams) ?? {};
	const requested = Array.isArray(search.model) ? search.model[0] : search.model;
	const variant = requested === "image-gpt-image-2-6-sunburst" ? "sunburst" : "flare";
	const params = new URLSearchParams();
	for (const [key, values] of Object.entries(search)) {
		for (const value of Array.isArray(values) ? values : [values]) {
			if (value !== undefined) params.append(key, value);
		}
	}
	permanentRedirect(`/gpt-image-2-6-${variant}${params.size ? `?${params}` : ""}`);
}
