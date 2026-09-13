import { getSession } from "@auth/lib/server";
import {
	RegisteredEditor,
	type CreatePageFilters,
} from "@media/components/editor/RegisteredEditor";
import { isAnonymousUser } from "@repo/auth/lib/anonymous-boundary";
import { MainAccountBoundary } from "@shared/components/MainAccountBoundary";
import { RegisteredWorkspaceBoundary } from "@shared/components/RegisteredWorkspaceBoundary";

import { LandingPage } from "../../modules/landing/components/LandingPage";
import { createPublicPageMetadata } from "../../modules/public-content/lib/metadata";

export const metadata = createPublicPageMetadata({
	path: "/create",
	title: "AI Image to Image Editor",
	description: "Upload a reference image, choose an available AI model, and describe your edit.",
	index: false,
});

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
