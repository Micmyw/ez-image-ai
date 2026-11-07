"use client";

import { useSession } from "@auth/hooks/use-session";
import { creditAccountQueryKey } from "@media/lib/credit-account-query";
import { useUpgrade } from "@payments/components/upgrade-context";
import { defaultUpgradeSelection, upgradeHref } from "@payments/lib/upgrade-selection";
import { sourceTemplateDisplayCredits } from "@repo/config/video-template-display-pricing";
import {
	getVideoTemplate,
	isRapTemplate,
	isSourceTemplateKey,
	sourceTemplateRoles,
	videoTemplateDescriptionKey,
	type PublicVideoTemplate,
	type SourceTemplateKey,
} from "@repo/config/video-template-library";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRightIcon, ImagePlusIcon, ShieldCheckIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { saveVideoEffectPaymentReturn } from "../../video-effects/lib/payment-return";
import { videoTemplatesApi, type TemplateQuote } from "../lib/api";
import {
	applyTemplateHandoff,
	createTemplateConfirmation,
	emptyTemplateDraft,
	readTemplateDraft,
	rejectTemplateConfirmation,
	setTemplateInput,
	templateDraftKey,
	templateRequest,
	updateTemplateChoices,
	type TemplateConfirmation,
	type TemplateDraft,
} from "../lib/draft";
import { TemplateInput } from "./TemplateInput";
import { TemplateJob, TemplateHistory } from "./TemplateJob";
import { TemplateOptions } from "./TemplateOptions";
import { TemplatePreview, TemplatePreviewProvider } from "./TemplatePreview";
import { FlyingCarVariants, TemplateFormat, TemplateRoleLabel } from "./TemplateSetup";

export function TemplateWorkspace({
	template,
	initialJobId = null,
	initialAssetId = null,
}: {
	template: PublicVideoTemplate;
	initialJobId?: string | null;
	initialAssetId?: string | null;
}) {
	const t = useTranslations("videoTemplates");
	const { user } = useSession();
	if (!isSourceTemplateKey(template.key))
		return (
			<TemplatePreviewProvider>
				<div className="vt-workspace">
					<section className="vt-notice">
						<h2>{t("unavailable")}</h2>
						<p>{t("legacyHint")}</p>
					</section>
					{template.sample && (
						<aside className="vt-preview-panel">
							<TemplatePreview template={template} priority />
						</aside>
					)}
				</div>
			</TemplatePreviewProvider>
		);
	const templateKey = template.key;
	const contentKey = videoTemplateDescriptionKey(template);
	if (!user || user.isAnonymous) {
		const search = new URLSearchParams();
		if (initialJobId) search.set("job", initialJobId);
		if (initialAssetId) search.set("asset", initialAssetId);
		const returnPath = `${template.canonicalPath}${search.size ? `?${search}` : ""}`;
		const loginHref = `/login?redirectTo=${encodeURIComponent(returnPath)}`;
		const options = emptyTemplateDraft("guest", templateKey).options;
		const roles = sourceTemplateRoles(templateKey, options);
		return (
			<TemplatePreviewProvider>
				<div className="vt-workspace">
					<section className="vt-creator" id="template-creator" aria-label={t("workspace")}>
						<div className="vt-section-heading">
							<h2>{t("workspace")}</h2>
						</div>
						<p className="vt-help">{t("presetIncluded")}</p>
						<FlyingCarVariants templateKey={templateKey} assetId={initialAssetId} />
						<div className="vt-step-heading">
							<span>1</span>
							<h3>{t("photoStep")}</h3>
						</div>
						<div className="vt-inputs vt-guest-inputs" data-count={roles.length}>
							{roles.map((role) => (
								<div className="vt-input" key={role}>
									<p className="vt-input-label">
										<TemplateRoleLabel
											templateKey={templateKey}
											role={role}
											preset={options.preset}
										/>
									</p>
									<Link href={loginHref} className="vt-upload" prefetch={false}>
										<span>
											<ImagePlusIcon aria-hidden />
											<strong>{t(role === "subject" ? "imageSignIn" : "photoSignIn")}</strong>
										</span>
									</Link>
								</div>
							))}
						</div>
						<p className="vt-help">{t(`details.${contentKey as "original-rap"}.photoHint`)}</p>
						<div className="vt-step-heading">
							<span>2</span>
							<h3>{t("settingsStep")}</h3>
						</div>
						<TemplateFormat options={options} />
						<div className="vt-step-heading">
							<span>3</span>
							<h3>{t("reviewStep")}</h3>
						</div>
						<p className="vt-help">{t("signInHint")}</p>
						<Link className="vt-primary" href={loginHref} prefetch={false}>
							{t("signIn")}
						</Link>
						<p className="vt-help vt-private-note">
							<ShieldCheckIcon aria-hidden />
							{t("privateHint")}
						</p>
					</section>
					<aside className="vt-preview-panel">
						<div className="vt-preview-heading">
							<h2>{t("previewHeading")}</h2>
							<span>{t("hoverHint")}</span>
						</div>
						<TemplatePreview template={template} layout="detail" priority />
						<p>{t("referenceNote")}</p>
						<div className="vt-preview-story">
							<h3>{t("guide.audio")}</h3>
							<p>{t(`details.${contentKey as "original-rap"}.sound`)}</p>
						</div>
					</aside>
				</div>
			</TemplatePreviewProvider>
		);
	}
	return (
		<OwnedTemplateWorkspace
			key={`${user.id}:${templateKey}`}
			ownerId={user.id}
			template={template}
			templateKey={templateKey}
			initialJobId={initialJobId}
			initialAssetId={initialAssetId}
		/>
	);
}

function OwnedTemplateWorkspace({
	ownerId,
	template,
	templateKey,
	initialJobId,
	initialAssetId,
}: {
	ownerId: string;
	template: PublicVideoTemplate;
	templateKey: SourceTemplateKey;
	initialJobId: string | null;
	initialAssetId: string | null;
}) {
	const t = useTranslations("videoTemplates");
	const contentKey = videoTemplateDescriptionKey(template);
	const queryClient = useQueryClient();
	const upgrade = useUpgrade();
	const [draft, setDraft] = useState(() => emptyTemplateDraft(ownerId, templateKey));
	const current = useRef(draft);
	const [restored, setRestored] = useState(false);
	const [quote, setQuote] = useState<TemplateQuote | null>(null);
	const [busy, setBusy] = useState<"quote" | "submit" | null>(null);
	const [uploadingRoles, setUploadingRoles] = useState<ReadonlySet<string>>(() => new Set());
	const [error, setError] = useState<string | null>(null);
	const [expired, setExpired] = useState(false);
	const active = useRef(true);
	const operation = useRef(false);
	const access = useQuery({
		queryKey: ["video-templates", "access", ownerId, templateKey],
		queryFn: () => videoTemplatesApi.access({ templateKey }),
		retry: false,
		staleTime: 5 * 60_000,
		gcTime: 30 * 60_000,
		refetchOnWindowFocus: false,
	});
	const storageKey = templateDraftKey(ownerId, templateKey);
	const update = (next: TemplateDraft) => {
		current.current = next;
		setDraft(next);
	};
	useEffect(() => {
		active.current = true;
		let cancelled = false;
		let next = emptyTemplateDraft(ownerId, templateKey);
		try {
			next = readTemplateDraft(localStorage.getItem(storageKey), ownerId, templateKey) ?? next;
		} catch {}
		if (initialJobId) next = { ...next, jobId: initialJobId };
		update(next);
		setRestored(true);
		const handoffBase = next;
		const handoffRole = sourceTemplateRoles(templateKey, handoffBase.options)[0];
		if (
			initialAssetId &&
			!next.confirmation &&
			handoffRole &&
			!next.inputs.some((input) => input.role === handoffRole)
		)
			void videoTemplatesApi.inputs
				.get({ assetId: initialAssetId })
				.then((result) => {
					if (!cancelled) {
						const applied = applyTemplateHandoff(
							current.current,
							handoffBase,
							handoffRole,
							result.assetId,
						);
						if (applied !== current.current) {
							setQuote(null);
							update(applied);
						}
					}
				})
				.catch(() => {
					if (!cancelled) setError("requestFailed");
				});
		return () => {
			cancelled = true;
			active.current = false;
		};
	}, [ownerId, templateKey, storageKey, initialJobId, initialAssetId]);
	useEffect(() => {
		if (restored)
			try {
				localStorage.setItem(storageKey, JSON.stringify(draft));
			} catch {}
	}, [draft, restored, storageKey]);
	useEffect(() => {
		setExpired(Boolean(quote && Date.parse(quote.expiresAt) <= Date.now()));
		if (!quote) return;
		const timer = setTimeout(
			() => setExpired(true),
			Math.max(0, Date.parse(quote.expiresAt) - Date.now()),
		);
		return () => clearTimeout(timer);
	}, [quote]);
	const roles = sourceTemplateRoles(templateKey, draft.options);
	const previewTemplate =
		isRapTemplate(templateKey) && draft.options.stageId
			? (getVideoTemplate(`rap-${draft.options.stageId}`) ?? template)
			: template;
	const complete = roles.every((role) => draft.inputs.some((input) => input.role === role));
	const available = access.data?.available === true;
	const uploading = uploadingRoles.size > 0;
	const inputLocked = busy !== null || Boolean(draft.confirmation) || !restored;
	const locked = inputLocked || uploading;
	const displayCredits =
		quote && !expired
			? quote.credits
			: sourceTemplateDisplayCredits(access.data?.pricing, draft.options);
	function changed(next: TemplateDraft) {
		update(next);
		setQuote(null);
		setError(null);
	}
	function errorKey(value: unknown) {
		const message =
			value && typeof value === "object" ? (value as { message?: unknown }).message : "";
		const code = typeof message === "string" ? message : "";
		return /INSUFFICIENT/.test(code)
			? "insufficient"
			: /QUOTE_EXPIRED|QUOTE.*CHANGED/.test(code)
				? "quoteExpired"
				: /DISABLED|UNAVAILABLE|NOT_READY/.test(code)
					? "unavailable"
					: "requestFailed";
	}
	async function generate() {
		if (operation.current || locked || !complete || !available || !displayCredits) return;
		if (quote && !expired) {
			confirm(quote);
			return;
		}
		operation.current = true;
		setBusy("quote");
		setError(null);
		const request = templateRequest(current.current);
		let confirmedQuote: TemplateQuote | null = null;
		try {
			const next = await videoTemplatesApi.quote(request);
			if (
				active.current &&
				JSON.stringify(templateRequest(current.current)) === JSON.stringify(request)
			) {
				if (next.credits !== displayCredits) {
					// Never silently charge a price different from the displayed button.
					setQuote(next);
					setError("priceChanged");
				} else confirmedQuote = next;
			}
		} catch (caught) {
			if (active.current) setError(errorKey(caught));
		} finally {
			operation.current = false;
			if (active.current) setBusy(null);
		}
		if (confirmedQuote && active.current) confirm(confirmedQuote);
	}
	async function submit(confirmation: TemplateConfirmation) {
		if (operation.current) return;
		operation.current = true;
		setBusy("submit");
		setError(null);
		try {
			const response = await videoTemplatesApi.jobs.create(confirmation.input);
			if (!active.current) return;
			update({ ...current.current, confirmation: null, jobId: response.jobId });
			setQuote(null);
			window.history.replaceState(
				null,
				"",
				`${template.canonicalPath}?job=${encodeURIComponent(response.jobId)}`,
			);
			void queryClient.invalidateQueries({ queryKey: ["video-templates", "history", ownerId] });
			void queryClient.invalidateQueries({ queryKey: creditAccountQueryKey(ownerId) });
		} catch (caught) {
			if (active.current) {
				const next = rejectTemplateConfirmation(
					current.current,
					caught,
					confirmation.input.idempotencyKey,
				);
				if (next !== current.current) {
					update(next);
					setQuote(null);
				}
				setError(errorKey(caught));
			}
		} finally {
			operation.current = false;
			if (active.current) setBusy(null);
		}
	}
	function confirm(value: TemplateQuote) {
		if (operation.current || Date.parse(value.expiresAt) <= Date.now() || !available || locked)
			return;
		const confirmation = createTemplateConfirmation(current.current, value);
		const next = { ...current.current, confirmation };
		try {
			localStorage.setItem(storageKey, JSON.stringify(next));
		} catch {
			setError("saveFailed");
			return;
		}
		update(next);
		void submit(confirmation);
	}
	function buyCredits() {
		try {
			localStorage.setItem(storageKey, JSON.stringify(current.current));
		} catch {
			setError("saveFailed");
			return;
		}
		saveVideoEffectPaymentReturn(ownerId, template.canonicalPath);
		const selection = { ...defaultUpgradeSelection, view: "credit-packs" as const };
		if (upgrade) upgrade(selection);
		else
			window.location.assign(
				`${upgradeHref(selection)}&returnTo=${encodeURIComponent(template.canonicalPath)}`,
			);
	}
	return (
		<TemplatePreviewProvider>
			<div className="vt-workspace">
				<section className="vt-creator" id="template-creator" aria-label={t("workspace")}>
					<div className="vt-section-heading">
						<h2>{t("workspace")}</h2>
						<span>{t(`inputs.${template.inputLabel}`)}</span>
					</div>
					<FlyingCarVariants templateKey={templateKey} assetId={initialAssetId} disabled={locked} />
					{!available && (
						<div className="vt-notice" aria-live="polite">
							<strong>
								{t(
									access.isPending
										? "checking"
										: access.isError
											? "availabilityFailed"
											: "unavailable",
								)}
							</strong>
							<p>{t("unavailableHint")}</p>
							{access.isError && (
								<button type="button" onClick={() => void access.refetch()}>
									{t("retry")}
								</button>
							)}
						</div>
					)}
					<TemplateOptions
						section="cast"
						templateKey={templateKey}
						value={draft.options}
						onChange={(options) => changed(updateTemplateChoices(current.current, options))}
						disabled={locked}
					/>
					{roles.length > 0 && (
						<div className="vt-step-heading">
							<span>1</span>
							<h3>{t("photoStep")}</h3>
						</div>
					)}
					<div className="vt-inputs" data-count={roles.length}>
						{roles.map((role) => (
							<TemplateInput
								key={`${templateKey}:${role}`}
								templateKey={templateKey}
								role={role}
								preset={draft.options.preset}
								assetId={draft.inputs.find((input) => input.role === role)?.assetId}
								maximumBytes={access.data?.maximumInputBytes ?? 10_000_000}
								disabled={inputLocked || !available}
								onBusy={(isBusy) =>
									setUploadingRoles((previous) => {
										const next = new Set(previous);
										if (isBusy) next.add(role);
										else next.delete(role);
										return next;
									})
								}
								onChange={(assetId) => changed(setTemplateInput(current.current, role, assetId))}
							/>
						))}
					</div>
					{roles.length >= 2 && (
						<button
							type="button"
							className="vt-text-button"
							disabled={locked || !complete}
							onClick={() => {
								const first = draft.inputs.find((input) => input.role === roles[0]);
								const second = draft.inputs.find((input) => input.role === roles[1]);
								if (first && second)
									changed(
										setTemplateInput(
											setTemplateInput(current.current, roles[0]!, second.assetId),
											roles[1]!,
											first.assetId,
										),
									);
							}}
						>
							<ArrowLeftRightIcon aria-hidden />
							{t("swap")}
						</button>
					)}
					{roles.length > 0 && (
						<p className="vt-help">
							{t("photoFormats", {
								megabytes: Math.floor(
									(access.data?.maximumInputBytes ?? 10 * 1024 * 1024) / 1024 / 1024,
								),
							})}
						</p>
					)}
					<p className="vt-help">{t("photoRights")}</p>
					<p className="vt-help">{t(`details.${contentKey as "original-rap"}.photoHint`)}</p>
					<div className="vt-step-heading">
						<span>2</span>
						<h3>{t("settingsStep")}</h3>
					</div>
					<TemplateOptions
						section="settings"
						templateKey={templateKey}
						value={draft.options}
						onChange={(options) => changed(updateTemplateChoices(current.current, options))}
						disabled={locked}
					/>
					<div className="vt-step-heading">
						<span>3</span>
						<h3>{t("reviewStep")}</h3>
					</div>
					<p className="vt-credit-price" aria-live="polite">
						{displayCredits ? t("creditPrice", { credits: displayCredits }) : t("priceLoading")}
					</p>
					{!complete && <p className="vt-help">{t("readyPhotos")}</p>}
					{error && (
						<p className="vt-error" role="alert">
							{t(error as "requestFailed")}
						</p>
					)}
					{draft.confirmation ? (
						<div className="vt-notice">
							<p>{t("confirmationPending")}</p>
							<button
								type="button"
								className="vt-primary"
								disabled={busy !== null}
								onClick={() => void submit(draft.confirmation!)}
							>
								{t(busy === "submit" ? "submitting" : "recover")}
							</button>
						</div>
					) : (
						<button
							type="button"
							className="vt-primary"
							disabled={locked || !available || !complete || !displayCredits}
							onClick={() => void generate()}
						>
							{t(busy === "submit" ? "submitting" : busy === "quote" ? "quoting" : "generate", {
								credits: displayCredits ?? "…",
							})}
						</button>
					)}
					{expired && (
						<p aria-live="polite" className="vt-help">
							{t("quoteExpired")}
						</p>
					)}
					<p className="vt-help">{t("quoteHint")}</p>
					<div className="vt-actions">
						<button type="button" onClick={buyCredits}>
							{t("addCredits")}
						</button>
						<a href="#template-history">{t("history")}</a>
					</div>
				</section>
				<aside className="vt-preview-panel">
					{draft.jobId ? (
						<TemplateJob key={draft.jobId} ownerId={ownerId} jobId={draft.jobId} />
					) : (
						<>
							<div className="vt-preview-heading">
								<h2>{t("previewHeading")}</h2>
								<span>{t("hoverHint")}</span>
							</div>
							<TemplatePreview template={previewTemplate} layout="detail" />
							<p>{t("referenceNote")}</p>
							<div className="vt-preview-story">
								<h3>{t("guide.audio")}</h3>
								<p>{t(`details.${contentKey as "original-rap"}.sound`)}</p>
							</div>
						</>
					)}
				</aside>
			</div>
			<TemplateHistory
				ownerId={ownerId}
				templateKey={templateKey}
				onSelect={(jobId) => {
					update({ ...current.current, jobId });
					window.history.replaceState(
						null,
						"",
						`${template.canonicalPath}?job=${encodeURIComponent(jobId)}`,
					);
				}}
			/>
		</TemplatePreviewProvider>
	);
}
