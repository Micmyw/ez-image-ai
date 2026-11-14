"use client";

import { Alert, AlertDescription } from "@repo/ui/components/alert";
import { Button } from "@repo/ui/components/button";
import { Textarea } from "@repo/ui/components/textarea";
import { Turnstile } from "@repo/ui/components/turnstile";
import { ArrowRightIcon, CheckIcon, ImageIcon, LockKeyholeIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { useGuestTrial } from "../../hooks/use-guest-trial";
import { ContentSafetyNotice } from "../ContentSafetyNotice";
import { GuestConversionActions } from "./GuestConversionActions";
import { GuestResultCard } from "./GuestResultCard";
import { useGuestShellLinking } from "./GuestShell";
import { GuestStatusPanel } from "./GuestStatusPanel";

const GUEST_TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_GUEST_TURNSTILE_SITE_KEY ?? null;
const LOCAL_TURNSTILE_EVIDENCE = "local-guest-generate";

export function GuestTrialWorkspace({
	registered = false,
	effectReturnPath,
}: {
	registered?: boolean;
	effectReturnPath?: string;
}) {
	const t = useTranslations("media.guest");
	const trial = useGuestTrial({ registered, effectReturnPath });
	const [turnstileToken, setTurnstileToken] = useState(
		GUEST_TURNSTILE_SITE_KEY ? "" : LOCAL_TURNSTILE_EVIDENCE,
	);
	const [turnstileResetKey, setTurnstileResetKey] = useState(0);
	const [challengeFailed, setChallengeFailed] = useState(false);
	const errorRef = useRef<HTMLDivElement>(null);
	const linkHandler = trial.actions.beginLink;
	const { setLinkHandler } = useGuestShellLinking(linkHandler);

	useEffect(() => {
		setLinkHandler(linkHandler);
		return () => setLinkHandler(null);
	}, [linkHandler, setLinkHandler]);

	useEffect(() => {
		if (trial.submitErrorNonce) errorRef.current?.focus();
	}, [trial.submitErrorNonce]);

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const consumedTurnstileToken = GUEST_TURNSTILE_SITE_KEY
			? turnstileToken
			: `${LOCAL_TURNSTILE_EVIDENCE}-${crypto.randomUUID()}`;
		void trial.actions.submit(consumedTurnstileToken);
		if (GUEST_TURNSTILE_SITE_KEY) resetChallenge();
	}

	function resetChallenge() {
		setTurnstileToken("");
		setTurnstileResetKey((value) => value + 1);
	}

	function handleChallengeError() {
		setChallengeFailed(true);
		resetChallenge();
	}

	function handleChallengeToken(token: string) {
		setChallengeFailed(false);
		setTurnstileToken(token);
	}

	const error = trial.errorKey ? t(`errors.${trial.errorKey}`) : null;
	const submissionError = trial.errorKey === "submit" || trial.errorKey === "turnstile";
	const terminalFailure = ["rejected", "failed"].includes(trial.view.state);
	const ready = trial.view.state === "ready";
	const showAccountActions =
		!registered &&
		(trial.view.state === "ready" ||
			(!trial.moderationError &&
				!trial.view.safety &&
				(trial.trialAllowance?.remaining === 0 ||
					["eligibility", "regionExcluded", "regionUnverified"].includes(trial.errorKey ?? ""))));

	return (
		<div className="px-4 py-6 sm:px-6 sm:py-8 max-w-6xl mx-auto">
			<header className="gap-3 flex flex-wrap items-end justify-between">
				<div>
					<h1 className="text-2xl leading-tight font-semibold sm:text-3xl tracking-tight text-balance">
						{ready ? t("states.ready") : t("title")}
					</h1>
					{!ready && <p className="mt-2 text-sm text-muted-foreground">{t("subtitle")}</p>}
				</div>
				{!ready && !registered && trial.trialAllowance && (
					<output className="px-3 py-1.5 text-xs rounded-full border border-border text-muted-foreground">
						{t("trialAllowance", {
							remaining: trial.trialAllowance.remaining,
							limit: trial.trialAllowance.limit,
						})}
					</output>
				)}
			</header>

			<div
				className={`mt-6 gap-5 grid ${trial.canSubmit && trial.draft ? "lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:items-start" : ""}`}
			>
				<div className={ready && !error ? "sr-only" : "min-w-0 space-y-4"}>
					{trial.canSubmit && trial.draft && (
						<form
							onSubmit={submit}
							className="space-y-5 p-4 sm:p-5 rounded-2xl border border-border bg-card"
						>
							<div className="pb-4 border-b border-border">
								<div className="gap-3 flex items-center">
									<span className="size-10 grid shrink-0 place-items-center rounded-xl bg-secondary text-ring">
										<ImageIcon className="size-5" aria-hidden="true" />
									</span>
									<div>
										<p className="text-sm font-medium">{t("sourceReady")}</p>
										<p className="mt-0.5 text-xs text-muted-foreground">{t("sourceHandoff")}</p>
									</div>
								</div>
							</div>
							<div>
								<label htmlFor="guest-edit-prompt" className="text-sm font-medium">
									{t("promptLabel")}
								</label>
								<Textarea
									id="guest-edit-prompt"
									className="mt-2 min-h-32 resize-y border-input bg-background focus-visible:ring-ring"
									maxLength={10_000}
									required
									disabled={trial.submissionLocked}
									value={trial.prompt}
									onChange={(event) => trial.setPrompt(event.target.value)}
								/>
								<p className="mt-1 text-xs text-right text-muted-foreground tabular-nums">
									{t("characterCount", { count: trial.prompt.length, maximum: 10_000 })}
								</p>
							</div>
							<div className="min-w-0 space-y-2">
								<div
									data-test="guest-product-selection"
									aria-current="true"
									className="min-w-0 gap-2 flex flex-wrap items-center"
								>
									<span className="min-w-0 gap-2 text-sm font-medium flex flex-1 items-center">
										<span className="size-6 grid shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
											<CheckIcon className="size-3.5" aria-hidden="true" />
										</span>
										<label className="sr-only" htmlFor="guest-trial-model">
											{t("modelLabel")}
										</label>
										<select
											id="guest-trial-model"
											value={trial.draft.productKey}
											disabled={trial.submissionLocked}
											onChange={(event) =>
												trial.setModel(
													event.target.value as "image-minimax-h3" | "image-nano-banana-2-lite",
												)
											}
											className="min-h-11 min-w-0 px-2 py-1 text-sm w-full rounded-lg border border-input bg-background"
										>
											<option value="image-minimax-h3">MiniMax H3 Image · 1K</option>
											<option value="image-nano-banana-2-lite">Nano Banana 2 Lite · 1K</option>
										</select>
									</span>
								</div>
								<button
									type="button"
									aria-label={t("qualityCta")}
									className="group min-h-11 gap-3 px-1 py-2 text-xs flex w-full items-center justify-between rounded-lg text-left text-muted-foreground transition hover:text-foreground"
									onClick={() => void trial.actions.beginLink("signup")}
								>
									<span className="min-w-0 gap-2 flex items-center">
										<LockKeyholeIcon className="size-4 shrink-0" aria-hidden="true" />
										<span>{t("qualityCta")}</span>
									</span>
									<ArrowRightIcon
										className="size-4 group-hover:translate-x-0.5 shrink-0 transition-transform"
										aria-hidden="true"
									/>
								</button>
							</div>
							{GUEST_TURNSTILE_SITE_KEY && (
								<Turnstile
									siteKey={GUEST_TURNSTILE_SITE_KEY}
									action="guest_generate"
									ariaLabel={t("challenge")}
									resetKey={turnstileResetKey}
									onToken={handleChallengeToken}
									onError={handleChallengeError}
									onExpire={resetChallenge}
								/>
							)}
							{challengeFailed && (
								<button
									type="button"
									className="min-h-11 text-sm font-semibold text-ring underline underline-offset-2"
									onClick={resetChallenge}
								>
									{t("retryChallenge")}
								</button>
							)}
							<Button
								type="submit"
								variant="primary"
								className="min-h-12 w-full"
								disabled={!trial.prompt.trim() || !turnstileToken || trial.isSubmitting}
								loading={trial.isSubmitting}
							>
								{t("submit")}
							</Button>
							<p className="text-xs leading-5 text-center text-muted-foreground">
								{t("temporary")}
							</p>
						</form>
					)}

					<div className={trial.canSubmit && !trial.isSubmitting ? "sr-only" : undefined}>
						<GuestStatusPanel
							view={trial.view}
							onViewStatus={trial.actions.viewStatus}
							onViewResult={trial.actions.viewResult}
						/>
					</div>

					{(error || terminalFailure) && (
						<div ref={errorRef} tabIndex={submissionError ? -1 : undefined}>
							{trial.errorKey === "submit" && trial.moderationError ? (
								<ContentSafetyNotice
									stage="prompt"
									outcome={trial.moderationError.outcome}
									reason={trial.moderationError.reason}
									billing="beforeGeneration"
									onRevise={() => document.getElementById("guest-edit-prompt")?.focus()}
								/>
							) : terminalFailure && trial.view.safety ? (
								<div className="space-y-2">
									<ContentSafetyNotice
										stage="output"
										outcome={trial.view.safety.outcome}
										reason={trial.view.safety.reason}
										billing="sponsored"
										jobId={trial.view.jobId}
									/>
									<p className="text-sm text-muted-foreground">
										{trial.view.trialConsumed ? t("trialConsumed") : t("trialNotConsumed")}
									</p>
								</div>
							) : (
								<Alert
									role={submissionError || terminalFailure ? "alert" : "status"}
									variant="error"
								>
									<AlertDescription>
										{error ?? t(`states.${trial.view.state}`)}
										{trial.errorKey === "access" && trial.view.state === "ready" && (
											<Button
												type="button"
												variant="ghost"
												className="mt-2 min-h-11"
												onClick={() => trial.actions.retryAccess()}
											>
												{t("retryPreview")}
											</Button>
										)}
										{terminalFailure && (
											<span className="mt-1 block">
												{trial.view.trialConsumed ? t("trialConsumed") : t("trialNotConsumed")}
											</span>
										)}
									</AlertDescription>
								</Alert>
							)}
						</div>
					)}
				</div>

				<div className="min-w-0 space-y-4">
					<GuestResultCard
						view={trial.view}
						resultUrl={trial.resultUrl}
						onDownload={() => void trial.actions.download()}
					/>
					{showAccountActions && <GuestConversionActions onBeginLink={trial.actions.beginLink} />}
					{!registered && ["ready", "rejected", "failed", "expired"].includes(trial.view.state) && (
						<div className="text-sm text-center">
							{trial.trialAllowance?.remaining ? (
								<a
									href="/#image-editor"
									className="min-h-11 font-medium inline-flex items-center text-ring underline underline-offset-4"
								>
									{t("editAnother")}
								</a>
							) : null}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
