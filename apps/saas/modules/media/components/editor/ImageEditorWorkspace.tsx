"use client";

import { useSession } from "@auth/hooks/use-session";
import { readEditorUpgradeDraft } from "@payments/lib/editor-upgrade";
import { Alert, AlertDescription } from "@repo/ui/components/alert";
import { Button } from "@repo/ui/components/button";
import {
	STUDIO_WORKSPACE_RESET_EVENT,
	type StudioWorkspaceResetDetail,
} from "@shared/components/studio/studio-context";
import { saasGrowthFunnel } from "@shared/lib/growth-analytics";
import { XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { canConfirmEditorUpgrade } from "../../lib/editor-entitlement";
import {
	isEditorProductKey,
	type EditorDraftInput,
	type EditorProductKey,
	type EditorRestoreNotice,
	type EditorRestoreState,
} from "../../lib/editor-recovery";
import {
	beginNewEditorWorkspaceState,
	type EditorWorkspaceState,
} from "../../lib/editor-workspace-state";
import type { GenerationFormValues } from "../../lib/form-schema";
import type { TemporaryReferenceReceipt } from "../../lib/temporary-reference-upload";
import { loadWorkspaceDraft, saveWorkspaceDraft } from "../../lib/workspace-draft";
import { GenerationForm } from "../GenerationForm";
import { RecentJobQueue } from "../RecentJobQueue";
import { EditorResultPanel } from "./EditorResultPanel";

export function ImageEditorWorkspace({
	claimedDraft = false,
	initialDraft,
	allowedProductKeys,
	restoreState,
	restoreNotice,
	parentJobId,
}: {
	claimedDraft?: boolean;
	initialDraft?: EditorDraftInput | null;
	allowedProductKeys: EditorProductKey[];
	restoreState: EditorRestoreState;
	restoreNotice: EditorRestoreNotice;
	parentJobId?: string | null;
}) {
	const t = useTranslations("media.create");
	const studio = useTranslations("studio");
	const { user } = useSession();
	const initialized = useRef(false);
	const [draftReady, setDraftReady] = useState(false);
	const [storageUnavailable, setStorageUnavailable] = useState(false);
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const example = searchParams.get("example");
	const draftPath = example ? `${pathname}?example=${encodeURIComponent(example)}` : pathname;
	const jobId = searchParams.get("job");
	const claimedDraftEventKey = useId();
	const [workspace, setWorkspace] = useState<EditorWorkspaceState>(() => ({
		parentJobId: parentJobId ?? null,
		initialDraft: initialDraft ?? null,
		formKey: 0,
		recoveryVisible: true,
	}));
	const [sourceReady, setSourceReady] = useState(restoreState === "ready");
	const [upgradeRestored, setUpgradeRestored] = useState(false);
	const [freshProductKey, setFreshProductKey] = useState<EditorProductKey>();

	useEffect(() => {
		if (initialized.current || !user?.id) return;
		initialized.current = true;
		const explicitRecovery = Boolean(
			initialDraft ||
			restoreState !== "idle" ||
			["asset", "reuseJob", "parentJob", "draftError", "upgrade", "resume"].some((key) =>
				searchParams.has(key),
			),
		);
		try {
			if (!explicitRecovery) {
				const saved = loadWorkspaceDraft(window.sessionStorage, user.id, Date.now(), draftPath);
				if (saved) {
					const { productKey, ...input } = saved.values;
					setWorkspace((current) => ({
						...current,
						initialDraft: {
							productKey,
							input: {
								...input,
								kind: input.sourceAssetId ? "image-to-image" : "text-to-image",
								...(input.sourceAssetId
									? { sourceAssetId: input.sourceAssetId }
									: { sourceAssetId: undefined }),
							},
						},
						parentJobId: saved.parentJobId,
						temporaryReference: saved.temporaryReference,
						formKey: current.formKey + 1,
					}));
					setSourceReady(false);
				}
			}
		} catch {
			setStorageUnavailable(true);
		}
		setDraftReady(true);
	}, [draftPath, initialDraft, restoreState, searchParams, user?.id]);
	useEffect(() => {
		function resetWorkspace(event: Event) {
			const productKey = (event as CustomEvent<StudioWorkspaceResetDetail>).detail?.productKey;
			if (!isEditorProductKey(productKey)) return;
			setFreshProductKey(productKey);
			setWorkspace(beginNewEditorWorkspaceState);
			setSourceReady(false);
			setUpgradeRestored(false);
		}
		window.addEventListener(STUDIO_WORKSPACE_RESET_EVENT, resetWorkspace);
		return () => window.removeEventListener(STUDIO_WORKSPACE_RESET_EVENT, resetWorkspace);
	}, []);
	const persistDraft = useCallback(
		(values: GenerationFormValues, temporaryReference?: TemporaryReferenceReceipt) => {
			if (!user?.id) return;
			try {
				setStorageUnavailable(
					!saveWorkspaceDraft(
						window.sessionStorage,
						user.id,
						{
							values,
							parentJobId: workspace.parentJobId,
							temporaryReference,
						},
						Date.now(),
						draftPath,
					),
				);
			} catch {
				setStorageUnavailable(true);
			}
		},
		[draftPath, user?.id, workspace.parentJobId],
	);

	useEffect(() => {
		if (claimedDraft && initialDraft) {
			void saasGrowthFunnel.draftClaimed(claimedDraftEventKey, initialDraft.productKey);
		}
	}, [claimedDraft, claimedDraftEventKey, initialDraft]);

	useEffect(() => {
		if (searchParams.get("upgrade") !== "complete" && searchParams.get("resume") !== "text") return;
		const restored = readEditorUpgradeDraft(window.sessionStorage);
		if (!restored) return;
		setWorkspace((current) => ({
			...current,
			parentJobId: restored.parentJobId,
			initialDraft: restored.draft,
			temporaryReference: restored.temporaryReference,
			formKey: current.formKey + 1,
			recoveryVisible: true,
		}));
		setFreshProductKey(undefined);
		setSourceReady(restored.sourceReady);
		setUpgradeRestored(
			searchParams.get("upgrade") === "complete" &&
				canConfirmEditorUpgrade(restored.draft.productKey, allowedProductKeys),
		);
		router.replace(`${pathname}?model=${encodeURIComponent(restored.draft.productKey)}`, {
			scroll: false,
		});
	}, [allowedProductKeys, pathname, router, searchParams]);

	const unlinkSource = useCallback(() => {
		setWorkspace((current) => (current.parentJobId ? { ...current, parentJobId: null } : current));
	}, []);

	function selectJob(nextJobId: string | null) {
		const url = new URL(window.location.href);
		if (nextJobId) url.searchParams.set("job", nextJobId);
		else url.searchParams.delete("job");
		for (const key of ["asset", "reuseJob", "parentJob", "draftError", "upgrade", "resume"])
			url.searchParams.delete(key);
		window.history.replaceState(null, "", url.pathname + url.search + url.hash);
	}

	function closePreview() {
		const url = new URL(window.location.href);
		url.searchParams.delete("job");
		window.history.replaceState(null, "", url.pathname + url.search + url.hash);
		document.getElementById("generation-prompt")?.focus({ preventScroll: true });
	}

	function beginNewEdit() {
		setWorkspace(beginNewEditorWorkspaceState);
		setFreshProductKey(undefined);
		setSourceReady(false);
		setUpgradeRestored(false);
		window.history.replaceState(null, "", pathname);
	}

	return (
		<div className="mt-6 min-w-0">
			{workspace.recoveryVisible && restoreNotice === "quality-upgrade-required" && (
				<Alert className="mb-5">
					<AlertDescription>{t("restore.qualityUpgradeRequired")}</AlertDescription>
				</Alert>
			)}
			{workspace.recoveryVisible && restoreState === "verifying" && (
				<Alert className="mb-5">
					<AlertDescription>{t("restore.verifying")}</AlertDescription>
				</Alert>
			)}
			{upgradeRestored && (
				<Alert className="mb-5">
					<AlertDescription>{t("restore.upgradeComplete")}</AlertDescription>
				</Alert>
			)}
			{workspace.recoveryVisible && restoreState === "error" && (
				<Alert className="mb-5" variant="error">
					<AlertDescription>{t("restore.unavailable")}</AlertDescription>
				</Alert>
			)}
			{storageUnavailable && (
				<output className="mb-3 text-xs text-amber-200 block">
					{studio("storageUnavailable")}
				</output>
			)}
			<div data-editor-layout="inline" className="min-w-0">
				<GenerationForm
					layout={pathname === "/image-to-image" ? "minimal" : "default"}
					onSourceChanged={unlinkSource}
					onDraftChange={draftReady ? persistDraft : undefined}
					jobId={jobId}
					key={workspace.formKey}
					initialDraft={workspace.initialDraft}
					initialTemporaryReference={workspace.temporaryReference}
					initialProductKey={freshProductKey}
					allowedProductKeys={allowedProductKeys}
					initialSourceReady={sourceReady}
					parentJobId={workspace.parentJobId}
					onCreated={selectJob}
				/>
				{jobId && (
					<div
						className="mt-5"
						id="current-editor-result"
						tabIndex={-1}
						aria-label={t("workspace.result")}
					>
						<div className="mb-2 flex justify-end">
							<Button type="button" variant="ghost" onClick={closePreview}>
								<XIcon className="size-4" aria-hidden="true" />
								{t("workspace.closePreview")}
							</Button>
						</div>
						<EditorResultPanel jobId={jobId} onNew={beginNewEdit} />
					</div>
				)}
			</div>
			<section className="mt-5" aria-label={t("workspace.recent")}>
				<RecentJobQueue selectedJobId={jobId} onSelect={selectJob} />
			</section>
		</div>
	);
}
