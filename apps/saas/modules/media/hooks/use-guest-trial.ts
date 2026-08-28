"use client";

import { saasGrowthFunnel } from "@shared/lib/growth-analytics";
import { orpcClient } from "@shared/lib/orpc-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getGuestDeviceId } from "../lib/guest-device";
import {
	isGuestTrialTerminal,
	resolveGuestTrialView,
	type GuestTrialSnapshot,
} from "../lib/guest-trial-state";

type GuestErrorKey = "eligibility" | "submit" | "access" | "download" | "link" | "turnstile";
type LinkDestination = "login" | "signup";
type GuestInitialLoad =
	| { kind: "redirect" }
	| { kind: "snapshot"; capabilityVersion?: string; snapshot: GuestTrialSnapshot }
	| {
			kind: "draft";
			capabilityVersion: string;
			draft: { sourceAssetId: string; prompt: string };
	  }
	| { kind: "unavailable"; capabilityVersion: string };

export function useGuestTrial({ registered = false }: { registered?: boolean } = {}) {
	const [capabilityVersion, setCapabilityVersion] = useState<string>();
	const [draft, setDraft] = useState<{ sourceAssetId: string; prompt: string }>();
	const [prompt, setPrompt] = useState("");
	const [snapshot, setSnapshot] = useState<GuestTrialSnapshot | null>(null);
	const [errorKey, setErrorKey] = useState<GuestErrorKey>();
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [resultUrl, setResultUrl] = useState<string | null>(null);
	const [accessRetryNonce, setAccessRetryNonce] = useState(0);
	const [submitErrorNonce, setSubmitErrorNonce] = useState(0);
	const [clockNow, setClockNow] = useState(() => new Date());
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
				if (result.kind === "redirect") {
					window.location.assign("/create");
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
				setErrorKey("eligibility");
			})
			.catch(() => {
				if (active) setErrorKey("eligibility");
			});
		return () => {
			active = false;
		};
	}, [pollJob, registered, updateSnapshot]);

	const view = useMemo(() => resolveGuestTrialView(snapshot, clockNow), [clockNow, snapshot]);
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
					void saasGrowthFunnel.guestResultViewed(view.resultAssetId!);
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
		setIsSubmitting(true);
		setErrorKey(undefined);
		try {
			const next = await orpcClient.media.submitGuestGeneration({
				capabilityVersion,
				sourceAssetId: draft.sourceAssetId,
				prompt: prompt.trim(),
				idempotencyKey: createIdempotencyKey("guest-submit"),
				deviceId: await getGuestDeviceId(),
				turnstileToken,
			});
			updateSnapshot(next);
			void saasGrowthFunnel.guestGenerationAdmitted(next.jobId);
		} catch {
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
		draft,
		prompt,
		setPrompt,
		canSubmit: Boolean(draft && capabilityVersion && !snapshot),
		isSubmitting,
		errorKey,
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
	const eligibility = await orpcClient.media.getGuestEligibility();
	if (eligibility.existingJobId) {
		return {
			kind: "snapshot",
			capabilityVersion: eligibility.capabilityVersion,
			snapshot: await pollJob(eligibility.existingJobId),
		};
	}
	if (eligibility.eligible && eligibility.claimedDraft) {
		return {
			kind: "draft",
			capabilityVersion: eligibility.capabilityVersion,
			draft: eligibility.claimedDraft,
		};
	}
	return { kind: "unavailable", capabilityVersion: eligibility.capabilityVersion };
}

function createIdempotencyKey(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}`;
}
