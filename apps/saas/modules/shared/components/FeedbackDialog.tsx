"use client";

import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/components/dialog";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";

import { buildFeedbackMailto, copyFeedbackEmail, type FeedbackKind } from "../lib/feedback";

import "./feedback.css";

export function FeedbackDialog({
	open,
	onOpenChange,
	supportEmail,
	initialKind = "idea",
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	supportEmail: string;
	initialKind?: FeedbackKind;
}) {
	const t = useTranslations("feedback");
	const id = useId();
	const [kind, setKind] = useState<FeedbackKind>(initialKind);
	const [accountEmail, setAccountEmail] = useState("");
	const [description, setDescription] = useState("");
	const [copyStatus, setCopyStatus] = useState<"copied" | "copyFailed" | null>(null);
	const draft = buildFeedbackMailto(
		supportEmail,
		{ kind, accountEmail, description },
		{
			subjectIdea: t("subjectIdea"),
			subjectBug: t("subjectBug"),
			accountEmail: t("accountEmail"),
			description: t("description"),
		},
	);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				closeLabel={t("close")}
				overlayProps={{ className: "feedback-backdrop z-[90] bg-black/55 backdrop-blur-[2px]" }}
				className="feedback-dialog studio-theme gap-4 border-white/10 p-5 z-[91] max-h-[calc(100dvh-2rem)] overflow-y-auto bg-[#201827] text-[#f2ecfa]"
				style={{ width: "calc(100vw - 2rem)", maxWidth: "34rem" }}
			>
				<DialogHeader className="pr-7">
					<DialogTitle>{t("title")}</DialogTitle>
					<DialogDescription className="feedback-muted">{t("rewardPolicy")}</DialogDescription>
				</DialogHeader>
				<p className="feedback-muted">{t("noAutomaticReward")}</p>
				<label className="feedback-field" htmlFor={`${id}-kind`}>
					{t("kind")}
					<select
						id={`${id}-kind`}
						value={kind}
						onChange={(event) => setKind(event.target.value === "bug" ? "bug" : "idea")}
					>
						<option value="idea">{t("idea")}</option>
						<option value="bug">{t("bug")}</option>
					</select>
				</label>
				<label className="feedback-field" htmlFor={`${id}-email`}>
					{t("accountEmail")}
					<input
						id={`${id}-email`}
						type="email"
						autoComplete="off"
						maxLength={254}
						value={accountEmail}
						onChange={(event) => setAccountEmail(event.target.value)}
						placeholder={t("emailPlaceholder")}
					/>
				</label>
				<label className="feedback-field" htmlFor={`${id}-description`}>
					{t("description")}
					<textarea
						id={`${id}-description`}
						rows={4}
						maxLength={1500}
						value={description}
						onChange={(event) => setDescription(event.target.value)}
						placeholder={t("descriptionPlaceholder")}
					/>
				</label>
				<p className="feedback-muted">{t("screenshots")}</p>
				<p className="feedback-muted">{t("privacy")}</p>
				<details className="feedback-preview">
					<summary>{t("preview")}</summary>
					<p>
						{t("recipient")}: {supportEmail}
					</p>
					<p>{kind === "bug" ? t("subjectBug") : t("subjectIdea")}</p>
					<pre>
						{t("accountEmail")}: {accountEmail.trim()}
						{"\n\n"}
						{t("description")}:{"\n"}
						{description}
					</pre>
				</details>
				<a href={draft} className="feedback-email-action">
					{t("openEmail")}
				</a>
				<div className="feedback-copy">
					<span className="feedback-address">{supportEmail}</span>
					<button
						type="button"
						onClick={async () => {
							const copied = await copyFeedbackEmail(supportEmail, navigator.clipboard);
							setCopyStatus(copied ? "copied" : "copyFailed");
						}}
					>
						{t("copy")}
					</button>
				</div>
				<output className="feedback-muted">
					{copyStatus ? t(copyStatus) : t("emailFallback")}
				</output>
			</DialogContent>
		</Dialog>
	);
}
