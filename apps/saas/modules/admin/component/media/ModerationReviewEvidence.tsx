"use client";

import { useLocale, useTranslations } from "next-intl";

export function ModerationReviewEvidence({
	availability,
	previewFailed,
	loading,
	queryFailed,
	result,
}: {
	availability: "AVAILABLE" | "DELETED" | "MISSING" | "UNSUPPORTED";
	previewFailed: boolean;
	loading: boolean;
	queryFailed: boolean;
	result?: {
		checkedAt: Date;
		decision: "ALLOW" | "REJECT" | "REVIEW" | "ERROR";
		reasonCode: string;
	};
}) {
	const t = useTranslations("admin.media.moderation");
	const locale = useLocale();
	return (
		<div className="space-y-2 text-sm">
			{availability !== "AVAILABLE" && (
				<output className="block">{t(`contentAvailability.${availability}`)}</output>
			)}
			{previewFailed && <p role="alert">{t("previewFailed")}</p>}
			{loading && <output className="block">{t("providerLoading")}</output>}
			{queryFailed && <p role="alert">{t("providerQueryFailed")}</p>}
			{result && (
				<div className="space-y-1 p-3 rounded-lg border">
					<p className="font-medium">
						{t("providerResultTitle")}: {t(`providerDecisions.${result.decision}`)}
					</p>
					<p>
						{t.has(`errors.${result.reasonCode}`)
							? t(`errors.${result.reasonCode}` as never)
							: t("errors.MODERATION_UNAVAILABLE")}
					</p>
					<p className="text-muted-foreground">
						{t("providerCheckedAt", {
							time: new Intl.DateTimeFormat(locale, {
								dateStyle: "medium",
								timeStyle: "short",
							}).format(new Date(result.checkedAt)),
						})}
					</p>
					<p className="text-muted-foreground">{t("providerResultNote")}</p>
				</div>
			)}
		</div>
	);
}
