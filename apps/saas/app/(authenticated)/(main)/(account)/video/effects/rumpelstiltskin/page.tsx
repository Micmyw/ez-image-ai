import { getSession } from "@auth/lib/server";
import { RUMPELSTILTSKIN_SOLO_EFFECT_ID } from "@repo/config/video-effects";
import { canAccessVideoEffect } from "@repo/config/video-effects-access.server";
import { getVideoTemplatePublicState } from "@repo/jobs/video-v1/template-admission";
import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import { notFound } from "next/navigation";

import { RumpelstiltskinWorkbench } from "../../../../../../../modules/video-effects/components/RumpelstiltskinWorkbench";

import "../../../../../../../modules/video-effects/video-effects.css";

export const metadata: Metadata = {
	title: "Rumpelstiltskin internal test",
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
	const generationAllowed = canAccessVideoEffect(
		process.env,
		session.user,
		RUMPELSTILTSKIN_SOLO_EFFECT_ID,
	);
	if (!generationAllowed) {
		if (!initialJobId) notFound();
		// History access survives admission closure, but the URL alone never grants it.
		const ownedJob = await getVideoTemplatePublicState(
			{ userId: session.user.id },
			initialJobId,
		).catch(() => null);
		if (ownedJob?.effectId !== RUMPELSTILTSKIN_SOLO_EFFECT_ID) notFound();
	}
	const messages = await getMessages();
	return (
		<NextIntlClientProvider messages={{ videoEffects: messages.videoEffects }}>
			<RumpelstiltskinWorkbench initialJobId={initialJobId} readOnly={!generationAllowed} />
		</NextIntlClientProvider>
	);
}
