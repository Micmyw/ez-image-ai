"use client";

import type { VideoOutputReport } from "@repo/config/video-output-report";
import { useFormatter, useTranslations } from "next-intl";

/** Shared by ordinary video receipts, their history cards and template receipts. */
export function VideoOutputDetails({ output }: { output: VideoOutputReport }) {
	const t = useTranslations("videoV1.output");
	const format = useFormatter();
	const { actual, requested } = output;
	return (
		<div className="space-y-2 text-sm" data-testid="video-output-details">
			<p>
				{t("actual", {
					seconds: format.number(actual.durationMillis / 1000, { maximumFractionDigits: 2 }),
					width: actual.width,
					height: actual.height,
					audio: t(actual.audioTracks > 0 ? "withAudio" : "withoutAudio"),
				})}
			</p>
			<p className="text-muted-foreground">
				{t("requested", {
					seconds: requested.durationSeconds,
					resolution: requested.resolution,
					ratio: requested.aspectRatio,
					audio: t(requested.sound ? "withAudio" : "withoutAudio"),
				})}
			</p>
			{output.warnings.length > 0 && (
				<aside
					role="note"
					aria-label={t("title")}
					className="space-y-2 border-amber-500/40 bg-amber-500/10 p-3 rounded-lg border"
				>
					<p className="font-medium">{t("title")}</p>
					<ul className="space-y-1 pl-5 list-disc">
						{output.warnings.map((warning) => (
							<li key={warning}>{t(`warnings.${warning}`)}</li>
						))}
					</ul>
					<p>{t("original")}</p>
				</aside>
			)}
		</div>
	);
}
