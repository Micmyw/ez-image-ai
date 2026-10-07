"use client";

import { useSession } from "@auth/hooks/use-session";
import { useSessionQuery } from "@auth/lib/api";
import {
	NextIntlClientProvider,
	useLocale,
	useMessages,
	type AbstractIntlMessages,
} from "next-intl";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { GenerationModeContext } from "../lib/generation-mode-context";
import { generatorMode, generatorModeUrl, validVideoJobId } from "../lib/generator-navigation";

const VideoWorkspace = dynamic(() =>
	import("../../video-v1/VideoWorkspace").then((module) => module.VideoWorkspace),
);

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
export function GenerationWorkspace({
	children,
	videoMessages,
}: {
	children: ReactNode;
	videoMessages: AbstractIntlMessages;
}) {
	const params = useSearchParams();
	const mode = generatorMode(params);
	const { user } = useSession();
	const { isPending: sessionPending } = useSessionQuery();
	const owner = user && !user.isAnonymous ? user.id : "guest";
	const messages = useMessages();
	const locale = useLocale();
	const [visitedVideo, setVisitedVideo] = useState(mode === "video");
	const root = useRef<HTMLDivElement>(null);
	const pendingFocus = useRef(false);
	const previousMode = useRef(mode);
	const signInDrafts = useRef(new Set<(destination: URL) => void>());
	const registerSignInDraft = useCallback((save: (destination: URL) => void) => {
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
		const focusTab = () => {
			const tab = root.current?.querySelector<HTMLElement>(
				`[data-generator-panel="${mode}"] [data-generator-mode="${mode}"]`,
			);
			if (!tab) return false;
			pendingFocus.current = false;
			tab.focus({ preventScroll: true });
			return true;
		};
		if (focusTab() || !root.current) return;
		// The first video visit loads a separate client chunk; retain keyboard focus after it mounts.
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
				prepareSignIn(destination) {
					const url = new URL(destination, window.location.origin);
					for (const save of signInDrafts.current) save(url);
					return url.pathname + url.search + url.hash;
				},
				selectMode(next) {
					if (next === mode) return;
					pendingFocus.current = true;
					if (next === "video") setVisitedVideo(true);
					window.history.pushState(null, "", generatorModeUrl(window.location.href, next));
				},
			}}
		>
			<div ref={root} data-generation-mode={mode}>
				<div data-generator-panel="image" hidden={mode !== "image"} inert={mode !== "image"}>
					{children}
				</div>
				{(visitedVideo || mode === "video") && !sessionPending && (
					<div data-generator-panel="video" hidden={mode !== "video"} inert={mode !== "video"}>
						<NextIntlClientProvider
							locale={locale}
							messages={{ ...messages, videoV1: videoMessages }}
						>
							<VideoWorkspace key={owner} initialJobId={validVideoJobId(params.get("videoJob"))} />
						</NextIntlClientProvider>
					</div>
				)}
			</div>
		</GenerationModeContext.Provider>
	);
}
