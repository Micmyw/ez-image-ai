"use client";

import { isPublicModerationReason } from "@repo/config/client";
import { Alert, AlertDescription } from "@repo/ui/components/alert";
import { Button } from "@repo/ui/components/button";
import { InfoIcon, ShieldAlertIcon } from "lucide-react";
import { useTranslations } from "next-intl";

export type SafetyBillingOutcome =
	| "beforeGeneration"
	| "waived"
	| "charged"
	| "returned"
	| "noCharge"
	| "sponsored"
	| "summary";

export function ContentSafetyNotice({
	stage,
	outcome,
	reason,
	billing,
	credits = "0",
	jobId,
	onRevise,
	className,
}: {
	stage: "prompt" | "input" | "output";
	outcome: "blocked" | "review" | "unsupportedLanguage" | "unavailable";
	reason?: string | null;
	billing: SafetyBillingOutcome;
	credits?: string;
	jobId?: string;
	onRevise?: () => void;
	className?: string;
}) {
	const t = useTranslations("media.safety");
	const blocked = outcome === "blocked";
	const safeReason = isPublicModerationReason(reason) ? reason : "restrictedContent";
	const Icon = blocked ? ShieldAlertIcon : InfoIcon;
	const linkClass =
		"inline-flex min-h-8 items-center rounded-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4";
	return (
		<Alert
			data-test="content-safety-notice"
			variant="default"
			className={`${blocked ? "border-amber-300/70 bg-amber-50/60 dark:border-amber-700 dark:bg-amber-950/30" : "border-border bg-muted/40"} ${className ?? ""}`}
		>
			<Icon aria-hidden="true" />
			<h3 className="text-base font-semibold leading-snug">
				{t(blocked ? `titles.${stage}` : `titles.${outcome}`)}
			</h3>
			<AlertDescription className="space-y-3">
				<p>
					{t(
						outcome === "review" || outcome === "unsupportedLanguage"
							? `summary.prompt.${outcome}`
							: `summary.${stage}.${outcome}`,
					)}
				</p>
				<dl className="space-y-3 text-sm">
					<div>
						<dt className="font-medium">{t("reasonLabel")}</dt>
						<dd className="mt-0.5 text-muted-foreground">
							{t(
								blocked
									? `reasons.${safeReason}`
									: outcome === "review"
										? "reviewRequired"
										: outcome === "unsupportedLanguage"
											? "unsupportedLanguage"
											: "reviewUncertain",
							)}
						</dd>
					</div>
					<div className="p-3 rounded-lg border border-border/60 bg-background/70">
						<dt className="font-medium">{t("creditsLabel")}</dt>
						<dd className="mt-0.5">{t(`billing.${billing}`, { credits })}</dd>
					</div>
					<div>
						<dt className="font-medium">{t("nextLabel")}</dt>
						<dd className="mt-0.5 text-muted-foreground">
							{t(
								billing === "sponsored"
									? "next.guestOutput"
									: blocked
										? `next.${stage}`
										: `next.${outcome}`,
							)}
						</dd>
					</div>
				</dl>
				{onRevise && (blocked || outcome === "review" || outcome === "unsupportedLanguage") && (
					<Button
						type="button"
						size="sm"
						variant="secondary"
						className="min-h-11"
						onClick={onRevise}
					>
						{t(stage === "input" ? "replaceImage" : "editInstruction")}
					</Button>
				)}
				<div className="gap-x-4 gap-y-2 text-sm flex flex-wrap">
					<a href="/terms" target="_blank" rel="noopener noreferrer" className={linkClass}>
						{t("policy")}
					</a>
					<a
						href="/contact#report-content"
						target="_blank"
						rel="noopener noreferrer"
						className={linkClass}
					>
						{t(blocked ? "appeal" : "support")}
					</a>
				</div>
				{jobId && (
					<p className="text-xs text-muted-foreground">
						{t("reference")} <code className="mt-1 block break-all select-all">{jobId}</code>
					</p>
				)}
			</AlertDescription>
		</Alert>
	);
}
