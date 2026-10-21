"use client";

import { useSession } from "@auth/hooks/use-session";
import { useSessionQuery } from "@auth/lib/api";
import { config } from "@config";
import { FeedbackRewardEntry } from "@shared/components/FeedbackRewardEntry";
import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { GenerationModeContext, type SignInDraftSaver } from "../lib/generation-mode-context";
import { generatorMode, generatorModeUrl, validVideoJobId } from "../lib/generator-navigation";
import { ComposerHeader } from "./editor/ComposerHeader";

const loadVideoWorkspace = () =>
	import("../../video-v1/LocalizedVideoWorkspace").then((module) => module.LocalizedVideoWorkspace);

const VideoWorkspace = dynamic(loadVideoWorkspace, {
	loading: VideoWorkspaceLoading,
});

function VideoWorkspaceLoading() {
	const t = useTranslations("imageToImage");
	return (
		<section className="studio-composer mt-6 min-h-72" data-test="video-workspace-loading">
			<ComposerHeader />
			<output className="p-6 text-sm block text-[#b7acbf]">{t("loading")}</output>
		</section>
	);
}

const preloadMode = (mode: "image" | "video") => {
	if (mode === "video") void loadVideoWorkspace().catch(() => {});
};

export function GenerationWorkspaceHeading({
	imageTitle,
	imageDescription,
	videoTitle,
	videoDescription,
}: {
	imageTitle: ReactNode;
	imageDescription: string;
	videoTitle: string;
	videoDescription: string;
}) {
	const video = generatorMode(useSearchParams()) === "video";
	return (
		<div className="max-w-4xl mx-auto text-center">
			<h1 className="studio-title max-w-4xl font-semibold mx-auto text-balance text-[#f6f2fb]">
				{video ? videoTitle : imageTitle}
			</h1>
			<p className="mt-3 max-w-2xl text-sm leading-6 mx-auto text-balance text-[#b7acbf]">
				{video ? videoDescription : imageDescription}
			</p>
		</div>
	);
}

/** A view switch only: each generator retains its own form, upload and request lifetime. */
export function GenerationWorkspace({ children }: { children: ReactNode }) {
	const params = useSearchParams();
	const mode = generatorMode(params);
	const { user } = useSession();
	const { isPending: sessionPending } = useSessionQuery();
	const owner = user && !user.isAnonymous ? user.id : "guest";
	const [visitedVideo, setVisitedVideo] = useState(mode === "video");
	const [signInPending, setSignInPending] = useState(false);
	const signInOperation = useRef<Promise<string> | null>(null);
	const root = useRef<HTMLDivElement>(null);
	const pendingFocus = useRef(false);
	const previousMode = useRef(mode);
	const signInDrafts = useRef(new Set<SignInDraftSaver>());
	const registerSignInDraft = useCallback((save: SignInDraftSaver) => {
		signInDrafts.current.add(save);
		return () => {
			signInDrafts.current.delete(save);
		};
	}, []);
	useEffect(() => {
		if (mode === "video") setVisitedVideo(true);
		if (previousMode.current !== mode) pendingFocus.current = true;
		previousMode.current = mode;
		if (!pendingFocus.current) return;
		let loadingTab: HTMLElement | null = null;
		const focusTab = () => {
			// Do not steal focus if the user has moved elsewhere during the download.
			if (
				loadingTab &&
				document.activeElement !== loadingTab &&
				document.activeElement !== document.body
			) {
				pendingFocus.current = false;
				return true;
			}
			const tab = root.current?.querySelector<HTMLElement>(
				`[data-generator-panel="${mode}"] [data-generator-mode="${mode}"]`,
			);
			if (!tab) return false;
			loadingTab = tab.closest('[data-test="video-workspace-loading"]') ? tab : null;
			pendingFocus.current = Boolean(loadingTab);
			tab.focus({ preventScroll: true });
			return !loadingTab;
		};
		if (focusTab() || !root.current) return;
		// Keep observing through the placeholder so replacing its tab preserves keyboard focus.
		const observer = new MutationObserver(() => {
			if (focusTab()) observer.disconnect();
		});
		observer.observe(root.current, { childList: true, subtree: true });
		return () => observer.disconnect();
	}, [mode]);
	return (
		<GenerationModeContext.Provider
			value={{
				mode,
				registerSignInDraft,
				preloadMode,
				async prepareSignIn(destination) {
					if (signInOperation.current) return signInOperation.current;
					setSignInPending(true);
					const operation = (async () => {
						const url = new URL(destination, window.location.origin);
						for (const save of [...signInDrafts.current]) await save(url);
						return url.pathname + url.search + url.hash;
					})();
					signInOperation.current = operation;
					try {
						return await operation;
					} finally {
						signInOperation.current = null;
						setSignInPending(false);
					}
				},
				selectMode(next) {
					if (next === mode || signInOperation.current) return;
					pendingFocus.current = true;
					if (next === "video") setVisitedVideo(true);
					window.history.pushState(null, "", generatorModeUrl(window.location.href, next));
				},
			}}
		>
			<div ref={root} data-generation-mode={mode} inert={signInPending} aria-busy={signInPending}>
				<div data-generator-panel="image" hidden={mode !== "image"} inert={mode !== "image"}>
					{children}
				</div>
				{(visitedVideo || mode === "video") && (
					<div data-generator-panel="video" hidden={mode !== "video"} inert={mode !== "video"}>
						{sessionPending ? (
							<VideoWorkspaceLoading />
						) : (
							<VideoWorkspace key={owner} initialJobId={validVideoJobId(params.get("videoJob"))} />
						)}
					</div>
				)}
				<FeedbackRewardEntry supportEmail={config.supportEmail} />
			</div>
		</GenerationModeContext.Provider>
	);
}
