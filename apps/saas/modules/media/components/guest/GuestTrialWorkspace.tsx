"use client";

import { Alert, AlertDescription } from "@repo/ui/components/alert";
import { Button } from "@repo/ui/components/button";
import { Textarea } from "@repo/ui/components/textarea";
import { Turnstile } from "@repo/ui/components/turnstile";
import { CheckIcon, ImageIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { useGuestTrial } from "../../hooks/use-guest-trial";
import { GuestConversionActions } from "./GuestConversionActions";
import { GuestResultCard } from "./GuestResultCard";
import { useGuestShellLinking } from "./GuestShell";
import { GuestStatusPanel } from "./GuestStatusPanel";

const GUEST_TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_GUEST_TURNSTILE_SITE_KEY ?? null;
const LOCAL_TURNSTILE_EVIDENCE = "local-guest-generate";

export function GuestTrialWorkspace({ registered = false }: { registered?: boolean }) {
	const t = useTranslations("media.guest");
	const trial = useGuestTrial({ registered });
	const [turnstileToken, setTurnstileToken] = useState(
		GUEST_TURNSTILE_SITE_KEY ? "" : LOCAL_TURNSTILE_EVIDENCE,
	);
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
		void trial.actions.submit(turnstileToken);
		if (GUEST_TURNSTILE_SITE_KEY) setTurnstileToken("");
	}

	const error = trial.errorKey ? t(`errors.${trial.errorKey}`) : null;
	const submissionError = trial.errorKey === "submit" || trial.errorKey === "turnstile";
	const terminalFailure = ["rejected", "failed"].includes(trial.view.state);

	return (
		<div className="px-4 py-8 sm:px-6 sm:py-10 lg:px-8 mx-auto max-w-[90rem]">
			<header className="max-w-3xl mx-auto text-center">
				<p className="text-xs font-bold text-violet-700 tracking-[0.16em] uppercase">
					{t("eyebrow")}
				</p>
				<h1 className="mt-3 text-3xl leading-tight font-semibold text-slate-950 sm:text-4xl lg:text-5xl tracking-[-0.035em] text-balance">
					{t("title")}
				</h1>
				<p className="mt-4 max-w-2xl text-base leading-7 text-slate-600 mx-auto text-balance">
					{t("subtitle")}
				</p>
			</header>

			<div className="mt-8 gap-5 lg:grid-cols-[minmax(20rem,0.9fr)_minmax(0,1.25fr)] lg:items-start grid">
				<div className="space-y-5">
					{trial.canSubmit && trial.draft && (
						<form
							onSubmit={submit}
							className="space-y-4 border-violet-200 bg-white/85 p-4 shadow-sm backdrop-blur sm:p-5 rounded-2xl border"
						>
							<div className="border-slate-200 bg-slate-50 p-3 rounded-xl border">
								<div className="gap-3 flex items-center">
									<span className="size-11 bg-violet-100 text-violet-700 grid shrink-0 place-items-center rounded-xl">
										<ImageIcon className="size-5" aria-hidden="true" />
									</span>
									<div>
										<p className="text-sm font-semibold text-slate-950">{t("sourceReady")}</p>
										<p className="mt-0.5 text-xs text-slate-500">{t("temporary")}</p>
									</div>
								</div>
							</div>
							<div>
								<label htmlFor="guest-edit-prompt" className="text-sm font-semibold text-slate-950">
									{t("promptLabel")}
								</label>
								<Textarea
									id="guest-edit-prompt"
									className="mt-2 min-h-32 border-slate-200 bg-white focus-visible:ring-violet-600 resize-y"
									maxLength={10_000}
									required
									value={trial.prompt}
									onChange={(event) => trial.setPrompt(event.target.value)}
								/>
								<p className="mt-1 text-xs text-slate-500 text-right tabular-nums">
									{trial.prompt.length.toLocaleString()} / 10,000
								</p>
							</div>
							<div className="space-y-2 border-violet-200 bg-violet-50/70 p-3 rounded-xl border">
								<div className="min-h-11 gap-3 bg-white px-3 py-2 flex items-center justify-between rounded-xl">
									<span className="gap-2 text-sm font-semibold text-slate-950 flex items-center">
										<span className="size-6 bg-violet-600 text-white grid place-items-center rounded-lg">
											<CheckIcon className="size-3.5" aria-hidden="true" />
										</span>
										{t("standard")}
									</span>
									<span className="text-xs font-semibold text-violet-700">{t("oneOutput")}</span>
								</div>
								<p className="text-xs leading-5 text-slate-600">{t("freeQueue")}</p>
								<p className="text-xs leading-5 text-slate-600">{t("temporary")}</p>
							</div>
							{GUEST_TURNSTILE_SITE_KEY && (
								<Turnstile
									siteKey={GUEST_TURNSTILE_SITE_KEY}
									action="guest_generate"
									ariaLabel={t("challenge")}
									onToken={setTurnstileToken}
									onError={() => setTurnstileToken("")}
									onExpire={() => setTurnstileToken("")}
								/>
							)}
							<Button
								type="submit"
								variant="primary"
								className="min-h-12 bg-indigo-600 hover:bg-indigo-700 w-full"
								disabled={!trial.prompt.trim() || !turnstileToken || trial.isSubmitting}
								loading={trial.isSubmitting}
							>
								{t("submit")}
							</Button>
						</form>
					)}

					<GuestStatusPanel
						view={trial.view}
						onViewStatus={trial.actions.viewStatus}
						onViewResult={trial.actions.viewResult}
					/>

					{(error || terminalFailure) && (
						<div ref={errorRef} tabIndex={submissionError ? -1 : undefined}>
							<Alert role={submissionError || terminalFailure ? "alert" : "status"} variant="error">
								<AlertDescription>
									{error ?? t(`states.${trial.view.state}`)}
									{terminalFailure && (
										<span className="mt-1 block">
											{trial.view.trialConsumed ? t("trialConsumed") : t("trialNotConsumed")}
										</span>
									)}
								</AlertDescription>
							</Alert>
						</div>
					)}
				</div>

				<div className="space-y-5">
					<GuestResultCard
						view={trial.view}
						resultUrl={trial.resultUrl}
						onDownload={() => void trial.actions.download()}
					/>
					{trial.view.state === "ready" && !registered && (
						<GuestConversionActions onBeginLink={trial.actions.beginLink} />
					)}
				</div>
			</div>
		</div>
	);
}
