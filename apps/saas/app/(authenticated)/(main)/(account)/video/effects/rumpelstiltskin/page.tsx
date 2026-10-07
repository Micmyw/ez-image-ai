import { getSession } from "@auth/lib/server";
import { RUMPELSTILTSKIN_SOLO_EFFECT_ID } from "@repo/config/video-effects";
import { getVideoTemplatePublicState } from "@repo/jobs/video-v1/template-admission";
import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import { notFound } from "next/navigation";

import { RumpelstiltskinWorkbench } from "../../../../../../../modules/video-effects/components/RumpelstiltskinWorkbench";

import "../../../../../../../modules/video-effects/video-effects.css";

export const metadata: Metadata = {
	title: "Rumpelstiltskin dance video",
	robots: { index: false, follow: false },
};

export default async function RumpelstiltskinPage({
	searchParams,
}: {
	searchParams: Promise<{ job?: string | string[] }>;
}) {
	const session = await getSession();
	if (!session?.user.id || session.user.isAnonymous) notFound();
	const { job } = await searchParams;
	const initialJobId = typeof job === "string" && /^[a-zA-Z0-9_-]{1,120}$/.test(job) ? job : null;
	if (initialJobId) {
		// Page discovery is authenticated; every historical task is separately owner-scoped.
		const ownedJob = await getVideoTemplatePublicState(
			{ userId: session.user.id },
			initialJobId,
		).catch(() => null);
		if (ownedJob?.effectId !== RUMPELSTILTSKIN_SOLO_EFFECT_ID) notFound();
	}
	const messages = await getMessages();
	return (
		<NextIntlClientProvider messages={{ videoEffects: messages.videoEffects }}>
			<RumpelstiltskinWorkbench initialJobId={initialJobId} readOnly={Boolean(initialJobId)} />
		</NextIntlClientProvider>
	);
}
