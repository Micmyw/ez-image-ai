"use client";

import { readEditorUpgradeDraft } from "@payments/lib/editor-upgrade";
import { Alert, AlertDescription } from "@repo/ui/components/alert";
import { saasGrowthFunnel } from "@shared/lib/growth-analytics";
import { useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useState } from "react";

import { canConfirmEditorUpgrade } from "../../lib/editor-entitlement";
import type {
	EditorDraftInput,
	EditorProductKey,
	EditorRestoreNotice,
	EditorRestoreState,
} from "../../lib/editor-recovery";
import {
	beginNewEditorWorkspaceState,
	type EditorWorkspaceState,
} from "../../lib/editor-workspace-state";
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
	const router = useRouter();
	const searchParams = useSearchParams();
	const claimedDraftEventKey = useId();
	const [workspace, setWorkspace] = useState<EditorWorkspaceState>(() => ({
		jobId: searchParams.get("job"),
		parentJobId: parentJobId ?? null,
		initialDraft: initialDraft ?? null,
		formKey: 0,
		recoveryVisible: true,
	}));
	const [sourceReady, setSourceReady] = useState(restoreState === "ready");
	const [upgradeRestored, setUpgradeRestored] = useState(false);

	useEffect(() => {
		if (claimedDraft && initialDraft) {
			void saasGrowthFunnel.draftClaimed(claimedDraftEventKey, initialDraft.productKey);
		}
	}, [claimedDraft, claimedDraftEventKey, initialDraft]);

	useEffect(() => {
		if (searchParams.get("upgrade") !== "complete") return;
		const restored = readEditorUpgradeDraft(window.sessionStorage);
		if (!restored) return;
		setWorkspace((current) => ({
			...current,
			parentJobId: restored.parentJobId,
			initialDraft: restored.draft,
			formKey: current.formKey + 1,
			recoveryVisible: true,
		}));
		setSourceReady(restored.sourceReady);
		setUpgradeRestored(canConfirmEditorUpgrade(restored.draft.productKey, allowedProductKeys));
		router.replace("/create", { scroll: false });
	}, [allowedProductKeys, router, searchParams]);

	function selectJob(nextJobId: string | null) {
		setWorkspace((current) => ({ ...current, jobId: nextJobId }));
		router.replace(nextJobId ? `/create?job=${encodeURIComponent(nextJobId)}` : "/create", {
			scroll: false,
		});
	}

	function beginNewEdit() {
		setWorkspace(beginNewEditorWorkspaceState);
		setSourceReady(false);
		setUpgradeRestored(false);
		router.replace("/create", { scroll: false });
	}

	return (
		<div>
			<header className="mb-6">
				<p className="font-medium text-xs tracking-[0.18em] text-primary uppercase">
					{t("eyebrow")}
				</p>
				<h1 className="mt-2 text-3xl font-medium md:text-4xl">{t("title")}</h1>
				<p className="mt-2 max-w-2xl text-muted-foreground">
					{workspace.initialDraft ? t("draftRestored") : t("subtitle")}
				</p>
			</header>
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
			<div className="gap-5 xl:grid-cols-[minmax(19rem,0.85fr)_minmax(0,1.35fr)] grid">
				<section className="p-5 md:p-6 rounded-2xl border bg-background">
					<GenerationForm
						key={workspace.formKey}
						initialDraft={workspace.initialDraft}
						allowedProductKeys={allowedProductKeys}
						initialSourceReady={sourceReady}
						parentJobId={workspace.parentJobId}
						onCreated={selectJob}
					/>
				</section>
				<EditorResultPanel jobId={workspace.jobId} onNew={beginNewEdit} />
			</div>
			<RecentJobQueue selectedJobId={workspace.jobId} onSelect={selectJob} />
		</div>
	);
}
