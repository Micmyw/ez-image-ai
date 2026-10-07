"use client";

import { RUMPELSTILTSKIN_SOLO_EFFECT_ID } from "@repo/config/video-effects";
import { useTranslations } from "next-intl";

import { VideoEffectGenerator } from "./VideoEffectGenerator";
import { VideoEffectHistory } from "./VideoEffectHistory";
import { VideoEffectJob } from "./VideoEffectJob";

export function RumpelstiltskinWorkbench({
	initialJobId,
	readOnly = false,
}: {
	initialJobId: string | null;
	readOnly?: boolean;
}) {
	const t = useTranslations("videoEffects");
	return (
		<main className="ve-page">
			<header className="ve-intro">
				<span className="ve-eyebrow">{t("rumpelstiltskin.label")}</span>
				<h1>{t("rumpelstiltskin.title")}</h1>
				<p>{t(readOnly ? "historyHint" : "rumpelstiltskin.testHint")}</p>
			</header>
			{readOnly ? (
				initialJobId && <VideoEffectJob jobId={initialJobId} />
			) : (
				<VideoEffectGenerator
					effectId={RUMPELSTILTSKIN_SOLO_EFFECT_ID}
					initialJobId={initialJobId}
					preview={
						<aside className="ve-sample-placeholder">
							<h2>{t("rumpelstiltskin.referenceTitle")}</h2>
							<p>{t("rumpelstiltskin.referenceHint")}</p>
							<p className="ve-microcopy">{t("privateHint")}</p>
						</aside>
					}
				/>
			)}
			<VideoEffectHistory family="rumpelstiltskin" />
		</main>
	);
}
