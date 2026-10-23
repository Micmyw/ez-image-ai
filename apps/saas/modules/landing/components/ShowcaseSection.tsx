import { getTranslations } from "next-intl/server";

import { SHOWCASE_ITEMS } from "../lib/showcase-items";
import { LandingArtwork } from "./LandingArtwork";
import { ShowcaseSectionClient } from "./ShowcaseSectionClient";

export async function ShowcaseSection({ standalone = false }: { standalone?: boolean } = {}) {
	const t = await getTranslations("home.showcase");
	// Keep the artwork manifest and build-time source hashes on the server. The
	// interactive grid receives the same image markup without downloading the table.
	const artworks = Object.fromEntries(
		SHOWCASE_ITEMS.map((item) => [
			item.key,
			<LandingArtwork
				key={item.key}
				src={item.image}
				alt={t(`items.${item.key}.alt`)}
				className="block h-auto w-full"
				sizes="(min-width: 1280px) 300px, (min-width: 900px) 33vw, 50vw"
			/>,
		]),
	);
	return <ShowcaseSectionClient standalone={standalone} artworks={artworks} />;
}
