"use client";

import { isLocale, type Locale } from "@repo/i18n/config";
import { Button } from "@repo/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/components/dialog";
import { NextIntlClientProvider, useLocale, useMessages, useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";

import { buildFeedbackMailto, copyFeedbackEmail, type FeedbackKind } from "../lib/feedback";

import "./feedback.css";

type FeedbackDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	supportEmail: string;
	initialKind?: FeedbackKind;
};
type FeedbackMessages = typeof import("@repo/i18n/translations/en/feedback.json").feedback;
const feedbackImports = {
	de: () =>
		import("@repo/i18n/translations/de/feedback.json").then((module) => module.default.feedback),
	en: () =>
		import("@repo/i18n/translations/en/feedback.json").then((module) => module.default.feedback),
	es: () =>
		import("@repo/i18n/translations/es/feedback.json").then((module) => module.default.feedback),
	fr: () =>
		import("@repo/i18n/translations/fr/feedback.json").then((module) => module.default.feedback),
};
const feedbackMessages = new Map<
	Locale,
	{ pending: Promise<FeedbackMessages>; value?: FeedbackMessages }
>();

export function loadFeedbackMessages(locale: string) {
	const selected = isLocale(locale) ? locale : "en";
	const cached = feedbackMessages.get(selected);
	if (cached) return cached.pending;
	const pending = feedbackImports[selected]()
		.then((value) => {
			const entry = feedbackMessages.get(selected);
			if (entry) entry.value = value;
			return value;
		})
		.catch((error: unknown) => {
			feedbackMessages.delete(selected);
			throw error;
		});
	feedbackMessages.set(selected, { pending });
	return pending;
}

/** Only the current locale's projection travels with the requested dialog. */
export function FeedbackDialog(props: FeedbackDialogProps) {
	const locale = useLocale();
	const messages = useMessages();
	const studio = useTranslations("studio");
	const entry = useTranslations("feedback");
	const [attempt, setAttempt] = useState(0);
	const [loaded, setLoaded] = useState<{
		locale: string;
		attempt: number;
		feedback?: FeedbackMessages;
		failed?: boolean;
	} | null>(null);
	const current = loaded?.locale === locale && loaded.attempt === attempt ? loaded : null;
	const feedback =
		current?.feedback ?? feedbackMessages.get(isLocale(locale) ? locale : "en")?.value;
	useEffect(() => {
		let active = true;
		loadFeedbackMessages(locale).then(
			(copy) => {
				if (active) setLoaded({ locale, attempt, feedback: copy });
			},
			() => {
				if (active) setLoaded({ locale, attempt, failed: true });
			},
		);
		return () => {
			active = false;
		};
	}, [locale, attempt]);
	if (!feedback)
		return (
			<Dialog open={props.open} onOpenChange={props.onOpenChange}>
				<DialogContent closeLabel={studio("closePanel")} className="feedback-dialog studio-theme">
					<DialogHeader>
						<DialogTitle>{entry("entry")}</DialogTitle>
						<DialogDescription aria-live="polite">
							{studio(current?.failed ? "error" : "loading")}
						</DialogDescription>
					</DialogHeader>
					{current?.failed && (
						<Button
							type="button"
							variant="secondary"
							onClick={() => setAttempt((value) => value + 1)}
						>
							{studio("retry")}
						</Button>
					)}
				</DialogContent>
			</Dialog>
		);
	return (
		<NextIntlClientProvider locale={locale} messages={{ ...messages, feedback }}>
			<FeedbackDialogContent {...props} />
		</NextIntlClientProvider>
	);
}

// Keep the stateful form mounted when its open prop changes, as before.
function FeedbackDialogContent({
	open,
	onOpenChange,
	supportEmail,
	initialKind = "idea",
}: FeedbackDialogProps) {
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
