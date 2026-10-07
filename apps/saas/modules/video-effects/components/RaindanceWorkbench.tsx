"use client";

import { RAINDANCE_SOLO_EFFECT_ID, RAINDANCE_DUO_EFFECT_ID } from "@repo/config/video-effects";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { VideoEffectGenerator } from "./VideoEffectGenerator";
import { VideoEffectHistory } from "./VideoEffectHistory";

export function RaindanceWorkbench({
	initialJobId,
	initialMode,
}: {
	initialJobId: string | null;
	initialMode?: string;
}) {
	const t = useTranslations("videoEffects");
	const [mode, setMode] = useState(initialMode === "duo" ? "duo" : "solo");
	const [jobId, setJobId] = useState(initialJobId);
	useEffect(() => {
		setJobId(initialJobId);
		if (initialMode || initialJobId) {
			setMode(initialMode === "duo" ? "duo" : "solo");
			return;
		}
		try {
			if (sessionStorage.getItem("ezpic.raindance.mode") === "duo") setMode("duo");
		} catch {
			/* Optional preference. */
		}
	}, [initialMode, initialJobId]);
	const effectId = mode === "solo" ? RAINDANCE_SOLO_EFFECT_ID : RAINDANCE_DUO_EFFECT_ID;
	return (
		<div className="rd-workspace" id="raindance-generator">
			<div className="rd-mode-bar">
				<fieldset aria-label={t("raindance.modeLabel")}>
					{(["solo", "duo"] as const).map((value) => (
						<button
							key={value}
							type="button"
							aria-pressed={mode === value}
							onClick={() => {
								setMode(value);
								setJobId(null);
								const url = new URL(window.location.href);
								url.searchParams.delete("job");
								if (value === "duo") url.searchParams.set("mode", "duo");
								else url.searchParams.delete("mode");
								window.history.replaceState(null, "", url.pathname + url.search + url.hash);
								try {
									sessionStorage.setItem("ezpic.raindance.mode", value);
								} catch {
									/* Optional preference. */
								}
							}}
						>
							{t(`raindance.${value}`)}
						</button>
					))}
				</fieldset>
				<span className="ve-beta">{t("beta")}</span>
			</div>
			<VideoEffectGenerator
				key={effectId}
				effectId={effectId}
				initialJobId={jobId}
				preview={
					<figure className="rd-scene">
						<img
							src="/images/blog/raindance-pier.webp"
							alt={t("raindance.sceneAlt")}
							width={1536}
							height={1024}
						/>
						<figcaption>
							<strong>{t("raindance.sceneTitle")}</strong>
							<span>{t("raindance.sceneCaption")}</span>
						</figcaption>
					</figure>
				}
			/>
			<VideoEffectHistory family="raindance" />
		</div>
	);
}
