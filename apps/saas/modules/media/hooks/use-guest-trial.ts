"use client";

import type { ImageAspectRatio, PublicModerationReason } from "@repo/config/client";
import type { GuestTrialProductKey, GuestTrialSkuKey } from "@repo/config/guest-trial";
import { captureBrowserGrowthAnalyticsAttribution } from "@repo/utils";
import {
	createJourneyReference,
	rememberJourneyJob,
	trackGenerationJourney,
} from "@shared/lib/generation-journey";
import { saasGrowthFunnel } from "@shared/lib/growth-analytics";
import { orpcClient } from "@shared/lib/orpc-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { sanitizeEffectEditorReturnPath } from "../../effects/lib/editor-selection";
import { getModerationErrorReason, getPromptSafetyOutcome } from "../lib/editor-error";
import { getGuestDeviceId } from "../lib/guest-device";
import {
	isGuestTrialTerminal,
	resolveGuestTrialView,
	type GuestTrialSnapshot,
} from "../lib/guest-trial-state";

type GuestDraft = {
	sourceAssetId: string;
	prompt: string;
	productKey: GuestTrialProductKey;
	skuKey: GuestTrialSkuKey;
	aspectRatio: ImageAspectRatio;
};
type GuestErrorKey =
	| "regionExcluded"
	| "regionUnverified"
	| "eligibility"
	| "submit"
	| "access"
	| "download"
	| "link"
	| "turnstile";
type LinkDestination = "login" | "signup";
type TrialAllowance = { limit: number; remaining: number; resetsAt: null };
type GuestInitialLoad = { reason?: string; trialAllowance?: TrialAllowance | null } & (
	| { kind: "redirect" }
	| { kind: "snapshot"; capabilityVersion?: string; snapshot: GuestTrialSnapshot }
	| {
			kind: "draft";
			capabilityVersion: string;
			draft: {
				sourceAssetId: string;
				prompt: string;
				productKey: GuestTrialProductKey;
				skuKey: GuestTrialSkuKey;
				aspectRatio: ImageAspectRatio;
			};
	  }
	| { kind: "unavailable"; capabilityVersion: string; draft?: GuestDraft | null }
);

export function useGuestTrial({
	registered = false,
	effectReturnPath,
}: { registered?: boolean; effectReturnPath?: string } = {}) {
	const returnAfterDraftLink = sanitizeEffectEditorReturnPath(effectReturnPath) ?? "/create";
	const [capabilityVersion, setCapabilityVersion] = useState<string>();
	const [draft, setDraft] = useState<{
		sourceAssetId: string;
		prompt: string;
		productKey: GuestTrialProductKey;
		skuKey: GuestTrialSkuKey;
		aspectRatio: ImageAspectRatio;
	}>();
	const [prompt, setPrompt] = useState("");
	const [snapshot, setSnapshot] = useState<GuestTrialSnapshot | null>(null);
	const [errorKey, setErrorKey] = useState<GuestErrorKey>();
	const [moderationError, setModerationError] = useState<{
		outcome: NonNullable<ReturnType<typeof getPromptSafetyOutcome>>;
		reason: PublicModerationReason | null;
	} | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [submissionLocked, setSubmissionLocked] = useState(false);
	const submissionAttempt = useRef<{
		idempotencyKey: string;
		fingerprint: string;
		actionRef?: string;
		startedAt: number;
	} | null>(null);
	const [resultUrl, setResultUrl] = useState<string | null>(null);
	const [accessRetryNonce, setAccessRetryNonce] = useState(0);
	const [submitErrorNonce, setSubmitErrorNonce] = useState(0);
	const [clockNow, setClockNow] = useState(() => new Date());
	const [trialAllowance, setTrialAllowance] = useState<TrialAllowance | null>(null);
	const initialLoad = useRef<{
		registered: boolean;
		request: Promise<GuestInitialLoad>;
	} | null>(null);
	const updateSnapshot = useCallback((next: GuestTrialSnapshot) => {
		setClockNow(new Date());
		setSnapshot(next);
	}, []);

	const pollJob = useCallback(
		async (jobId: string): Promise<GuestTrialSnapshot> => {
			return registered
				? await orpcClient.media.getGrantedGuestJob({ jobId })
				: await orpcClient.media.getGuestJob({ jobId });
		},
		[registered],
	);

	useEffect(() => {
		if (!initialLoad.current || initialLoad.current.registered !== registered) {
			initialLoad.current = {
				registered,
				request: loadInitialGuestTrial(registered, pollJob),
			};
		}
		let active = true;
		void initialLoad.current.request
			.then((result) => {
				if (!active) return;
				setTrialAllowance(result.trialAllowance ?? null);
				if (result.kind === "redirect") {
					window.location.assign(returnAfterDraftLink);
					return;
				}
				if (result.kind === "snapshot") {
					if (result.capabilityVersion) setCapabilityVersion(result.capabilityVersion);
					updateSnapshot(result.snapshot);
					return;
				}
				setCapabilityVersion(result.capabilityVersion);
				if (result.kind === "draft") {
					setDraft(result.draft);
					setPrompt(result.draft.prompt);
					return;
				}
				if (result.draft) setDraft(result.draft);
				setErrorKey(
					result.reason === "REGION_EXCLUDED"
						? "regionExcluded"
						: result.reason === "REGION_UNVERIFIED"
							? "regionUnverified"
							: "eligibility",
				);
			})
			.catch(() => {
				if (active) setErrorKey("eligibility");
			});
		return () => {
			active = false;
		};
	}, [pollJob, registered, returnAfterDraftLink, updateSnapshot]);

	const view = useMemo(() => resolveGuestTrialView(snapshot, clockNow), [clockNow, snapshot]);
	useEffect(() => {
		if (registered || !view.jobId || !isGuestTrialTerminal(view.state)) return;
		let active = true;
		let timer: number | undefined;
		const refresh = async () => {
			try {
				const eligibility = await loadGuestEligibility();
				if (!active) return;
				setTrialAllowance(eligibility.trialAllowance);
				if (eligibility.eligible && eligibility.claimedDraft) {
					setDraft(eligibility.claimedDraft);
					setPrompt(eligibility.claimedDraft.prompt);
					setCapabilityVersion(eligibility.capabilityVersion);
					setSnapshot(null);
					setResultUrl(null);
					setErrorKey(undefined);
				} else if (
					!eligibility.eligible &&
					eligibility.trialAllowance?.remaining &&
					eligibility.reason === "EXISTING_TRIAL"
				) {
					// Approved output can be visible while the previous job is still settling.
					timer = window.setTimeout(() => void refresh(), 2_500);
				}
			} catch {
				/* Keep the current result available; admission checks the quota again. */
			}
		};
		void refresh();
		return () => {
			active = false;
			if (timer) window.clearTimeout(timer);
		};
	}, [registered, view.jobId, view.state]);
	const requestAccess = useCallback(
		async (jobId: string, assetId: string, disposition: "inline" | "attachment") => {
			return registered
				? await orpcClient.media.getAssetAccessUrl({ assetId, disposition })
				: await orpcClient.media.getGuestAssetAccessUrl({ jobId, assetId, disposition });
		},
		[registered],
	);

	useEffect(() => {
		if (!snapshot) return;
		const deadlines = [
			...(snapshot.stage === "WAITING" ? [snapshot.estimateExpiresAt] : []),
			snapshot.resultExpiresAt,
		]
			.map((value) => new Date(value).getTime())
			.filter((value) => Number.isFinite(value) && value > clockNow.getTime());
		if (deadlines.length === 0) return;
		const nextDeadline = Math.min(...deadlines);
		const delay = Math.min(Math.max(nextDeadline - Date.now() + 25, 0), 2_147_483_647);
		const timer = window.setTimeout(() => setClockNow(new Date()), delay);
		return () => window.clearTimeout(timer);
	}, [clockNow, snapshot]);

	useEffect(() => {
		if (!snapshot?.jobId || isGuestTrialTerminal(view.state)) return;
		const timer = window.setInterval(() => {
			if (document.visibilityState !== "visible") return;
			void pollJob(snapshot.jobId)
				.then(updateSnapshot)
				.catch(() => setErrorKey("eligibility"));
		}, 2_500);
		return () => window.clearInterval(timer);
	}, [pollJob, snapshot?.jobId, updateSnapshot, view.state]);

	useEffect(() => {
		if (view.state !== "ready" || !view.jobId || !view.resultAssetId || resultUrl) return;
		void saasGrowthFunnel.guestResultReady(view.jobId);
		let active = true;
		void requestAccess(view.jobId, view.resultAssetId, "inline")
			.then((result) => {
				if (active) {
					setResultUrl(result.url);
					// Visibility is recorded by the decoded, on-screen image in GuestResultCard.
					setErrorKey((current) => (current === "access" ? undefined : current));
				}
			})
			.catch(() => {
				if (active) setErrorKey("access");
			});
		return () => {
			active = false;
		};
	}, [accessRetryNonce, requestAccess, resultUrl, view.jobId, view.resultAssetId, view.state]);

	function retryAccess() {
		if (view.state !== "ready" || !view.jobId || !view.resultAssetId) return;
		setResultUrl(null);
		setErrorKey(undefined);
		setAccessRetryNonce((value) => value + 1);
	}

	async function submit(turnstileToken: string) {
		if (!draft || !capabilityVersion || !prompt.trim()) return;
		if (!turnstileToken) {
			setErrorKey("turnstile");
			setSubmitErrorNonce((value) => value + 1);
			return;
		}
		const fingerprint = JSON.stringify([
			draft.sourceAssetId,
			draft.productKey,
			draft.skuKey,
			draft.aspectRatio,
			prompt.trim(),
		]);
		if (submissionAttempt.current && submissionAttempt.current.fingerprint !== fingerprint) return;
		submissionAttempt.current ??= {
			idempotencyKey: createIdempotencyKey("guest-submit"),
			fingerprint,
			actionRef: createJourneyReference(),
			startedAt: performance.now(),
		};
		void trackGenerationJourney({
			stage: "generate_clicked",
			actionRef: submissionAttempt.current.actionRef,
			publicModel: draft.productKey,
		});
		setSubmissionLocked(true);
		setIsSubmitting(true);
		setErrorKey(undefined);
		setModerationError(null);
		const attribution = captureBrowserGrowthAnalyticsAttribution();
		try {
			const next = await orpcClient.media.submitGuestGeneration({
				journey: { actionRef: submissionAttempt.current?.actionRef },
				capabilityVersion,
				productKey: draft.productKey,
				skuKey: draft.skuKey,
				sourceAssetId: draft.sourceAssetId,
				prompt: prompt.trim(),
				aspectRatio: draft.aspectRatio,
				idempotencyKey: submissionAttempt.current!.idempotencyKey,
				deviceId: await getGuestDeviceId(),
				turnstileToken,
			});
			rememberJourneyJob({
				jobKey: next.jobId,
				actionRef: submissionAttempt.current?.actionRef,
				startedAt: submissionAttempt.current!.startedAt,
			});
			updateSnapshot(next);
			setTrialAllowance((current) =>
				current ? { ...current, remaining: Math.max(0, current.remaining - 1) } : current,
			);
			void saasGrowthFunnel.guestGenerationAdmitted(next.jobId, attribution);
		} catch (error) {
			const outcome = getPromptSafetyOutcome(error);
			if (outcome) {
				submissionAttempt.current = null;
				setSubmissionLocked(false);
				setModerationError({
					outcome,
					reason: getModerationErrorReason(error),
				});
			}
			setErrorKey("submit");
			setSubmitErrorNonce((value) => value + 1);
		} finally {
			setIsSubmitting(false);
		}
	}

	async function download() {
		if (view.state !== "ready" || !view.jobId || !view.resultAssetId) return;
		setErrorKey(undefined);
		try {
			const result = await requestAccess(view.jobId, view.resultAssetId, "attachment");
			void saasGrowthFunnel.guestWatermarkedDownloaded(view.resultAssetId);
			window.location.assign(result.url);
		} catch {
			setErrorKey("download");
		}
	}

	async function beginLink(destination: LinkDestination) {
		if (registered || !capabilityVersion) return;
		setErrorKey(undefined);
		try {
			await orpcClient.media.beginGuestLinkIntent({
				capabilityVersion,
				...(view.jobId
					? { jobId: view.jobId }
					: draft
						? { sourceAssetId: draft.sourceAssetId }
						: {}),
				deviceId: await getGuestDeviceId(),
				returnPath: "/try",
				idempotencyKey: createIdempotencyKey("guest-link"),
			});
			void saasGrowthFunnel.guestSignInCtaStarted(view.jobId ?? "draft");
			window.location.assign(`/${destination}?redirectTo=${encodeURIComponent("/try")}`);
		} catch {
			setErrorKey("link");
		}
	}

	function viewStatus() {
		document.getElementById("guest-status-region")?.focus();
	}

	function viewResult() {
		document.getElementById("guest-result-region")?.focus();
	}

	return {
		view,
		trialAllowance,
		draft,
		prompt,
		setPrompt,
		canSubmit: Boolean(
			draft &&
			capabilityVersion &&
			!snapshot &&
			!["regionExcluded", "regionUnverified", "eligibility"].includes(errorKey ?? "") &&
			(trialAllowance?.remaining ?? 1) > 0,
		),
		submissionLocked,
		setModel(productKey: GuestTrialProductKey) {
			if (submissionLocked) return;
			setDraft((current) =>
				current
					? {
							...current,
							productKey,
							skuKey: productKey === "image-minimax-h3" ? "minimax-h3-1k" : "nano-banana-2-lite-1k",
						}
					: current,
			);
		},
		isSubmitting,
		errorKey,
		moderationError,
		resultUrl,
		submitErrorNonce,
		actions: { submit, download, beginLink, retryAccess, viewStatus, viewResult },
	};
}

async function loadInitialGuestTrial(
	registered: boolean,
	pollJob: (jobId: string) => Promise<GuestTrialSnapshot>,
): Promise<GuestInitialLoad> {
	if (registered) {
		const linked = await orpcClient.media.completeGuestLinkIntent({});
		if (linked.mode === "RESULT") {
			void saasGrowthFunnel.guestRegisteredSessionEstablished(linked.jobId);
			void saasGrowthFunnel.guestResultGrantCompleted(linked.jobId);
		}
		return linked.mode === "DRAFT"
			? { kind: "redirect" }
			: { kind: "snapshot", snapshot: await pollJob(linked.jobId) };
	}
	const eligibility = await loadGuestEligibility();
	if (eligibility.eligible && eligibility.claimedDraft) {
		return {
			kind: "draft",
			trialAllowance: eligibility.trialAllowance,
			capabilityVersion: eligibility.capabilityVersion,
			draft: eligibility.claimedDraft,
		};
	}
	if (eligibility.existingJobId) {
		return {
			kind: "snapshot",
			trialAllowance: eligibility.trialAllowance,
			capabilityVersion: eligibility.capabilityVersion,
			snapshot: await pollJob(eligibility.existingJobId),
		};
	}
	return {
		kind: "unavailable",
		reason: eligibility.reason,
		draft: eligibility.claimedDraft,
		capabilityVersion: eligibility.capabilityVersion,
		trialAllowance: eligibility.trialAllowance,
	};
}

async function loadGuestEligibility() {
	return orpcClient.media.getGuestEligibility({ deviceId: await getGuestDeviceId() });
}

function createIdempotencyKey(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}`;
}
