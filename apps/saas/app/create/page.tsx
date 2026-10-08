import { getSession } from "@auth/lib/server";
import {
	RegisteredEditor,
	type CreatePageFilters,
} from "@media/components/editor/RegisteredEditor";
import { isAnonymousUser } from "@repo/auth/lib/anonymous-boundary";
import { MainAccountBoundary } from "@shared/components/MainAccountBoundary";
import { RegisteredWorkspaceBoundary } from "@shared/components/RegisteredWorkspaceBoundary";
import { getLocale, getTranslations } from "next-intl/server";

import { LandingPage } from "../../modules/landing/components/LandingPage";
import type { PublicMetadataProps } from "../../modules/public-content/lib/indexing";
import { createPublicPageMetadata } from "../../modules/public-content/lib/metadata";

export async function generateMetadata(props: PublicMetadataProps) {
	const { searchParams } = props ?? {};
	const locale = await getLocale();
	const t = await getTranslations();
	return createPublicPageMetadata({
		searchParams: await searchParams,
		path: "/create",
		title: locale === "en" ? "AI Image to Image Editor" : t("home.hero.title"),
		description:
			locale === "en"
				? "Upload a reference image, choose an available AI model, and describe your edit."
				: t("home.hero.subtitle"),
		index: true,
	});
}

export default async function CreatePage({
	searchParams = Promise.resolve({}),
}: {
	searchParams?: Promise<CreatePageFilters>;
}) {
	const session = await getSession();
	if (!session || isAnonymousUser(session.user)) return <LandingPage workspace />;
	return (
		<RegisteredWorkspaceBoundary>
			<MainAccountBoundary>
				<LandingPage workspace editor={<RegisteredEditor searchParams={searchParams} />} />
			</MainAccountBoundary>
		</RegisteredWorkspaceBoundary>
	);
}
