import { permanentRedirect } from "next/navigation";

import { legacyEffectsDirectoryRedirect } from "../../../modules/public-content/lib/photo-idea-legacy";

export default async function LegacyEffectsPage({
	searchParams,
}: {
	searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
	permanentRedirect(legacyEffectsDirectoryRedirect((await searchParams) ?? {}));
}
