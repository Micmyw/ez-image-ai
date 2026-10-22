import { StudioShell } from "@shared/components/studio/StudioShell";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { modelPageForSlug } from "../../../../modules/models/lib/model-pages";

export default async function Layout({
	children,
	params,
}: {
	children: ReactNode;
	params: Promise<{ slug: string }>;
}) {
	// Reject unknown models before the child loading boundary streams a 200 response.
	if (!modelPageForSlug((await params).slug)) notFound();
	// Loading and streamed content share the same session observer. A second shell
	// could hydrate against a session already fetched by the loading shell.
	return <StudioShell>{children}</StudioShell>;
}
