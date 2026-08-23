"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useCallback, useEffect, useRef, useState } from "react";

import {
	createPersistedUploadState,
	getFileFingerprint,
	getPendingPartNumbers,
	parsePersistedUploadState,
	type PersistedUploadState,
} from "../lib/upload-state";

export type MediaUploadStatus = "idle" | "uploading" | "paused" | "verifying" | "error";

export interface MediaUploadItem {
	file: File;
	previewUrl: string | null;
	progress: number;
	status: MediaUploadStatus;
	assetId: string | null;
	error: string | null;
}

const STORAGE_PREFIX = "media-upload:";

export function useMediaUpload(onChange?: (assetIds: string[]) => void) {
	const [items, setItems] = useState<MediaUploadItem[]>([]);
	const abortControllers = useRef(new Map<string, AbortController>());
	const previewUrls = useRef(new Set<string>());

	useEffect(
		() => () => {
			for (const previewUrl of previewUrls.current) URL.revokeObjectURL(previewUrl);
			for (const controller of abortControllers.current.values()) controller.abort();
		},
		[],
	);

	const emitAssets = useCallback(
		(next: MediaUploadItem[]) => {
			onChange?.(next.flatMap((item) => (item.assetId ? [item.assetId] : [])));
		},
		[onChange],
	);

	const update = useCallback(
		(fingerprint: string, changes: Partial<MediaUploadItem>) => {
			setItems((current) => {
				const next = current.map((item) =>
					getFileFingerprint(item.file) === fingerprint ? { ...item, ...changes } : item,
				);
				emitAssets(next);
				return next;
			});
		},
		[emitAssets],
	);

	const upload = useCallback(
		async (file: File) => {
			const fingerprint = getFileFingerprint(file);
			const controller = new AbortController();
			abortControllers.current.set(fingerprint, controller);
			update(fingerprint, { status: "uploading", error: null });
			try {
				const saved = parsePersistedUploadState(
					localStorage.getItem(`${STORAGE_PREFIX}${fingerprint}`),
				);
				const session =
					saved ??
					(await orpcClient.media.createUploadSession({
						contentType: file.type,
						byteSize: file.size,
					}));
				if ("method" in session && session.method === "PUT") {
					const response = await fetch(session.uploadUrl, {
						method: "PUT",
						body: file,
						headers: { "Content-Type": file.type },
						signal: controller.signal,
					});
					if (!response.ok) throw new Error("The image upload failed");
					await orpcClient.media.completeUploadSession({ sessionId: session.sessionId });
					update(fingerprint, { status: "verifying", progress: 100, assetId: session.assetId });
					return;
				}
				const partSize = "partSize" in session ? session.partSize : 8 * 1024 * 1024;
				const state: PersistedUploadState = saved ?? {
					sessionId: session.sessionId,
					assetId: session.assetId,
					fileFingerprint: fingerprint,
					partCount: Math.ceil(file.size / partSize),
					completedParts: [],
				};
				localStorage.setItem(`${STORAGE_PREFIX}${fingerprint}`, createPersistedUploadState(state));
				for (const partNumber of getPendingPartNumbers(state)) {
					const { uploadUrl } = await orpcClient.media.createMultipartPartUrl({
						sessionId: state.sessionId,
						partNumber,
					});
					const start = (partNumber - 1) * partSize;
					const response = await fetch(uploadUrl, {
						method: "PUT",
						body: file.slice(start, Math.min(start + partSize, file.size)),
						signal: controller.signal,
					});
					const etag = response.headers.get("etag");
					if (!response.ok || !etag) throw new Error("A video part failed to upload");
					state.completedParts = [...state.completedParts, { partNumber, etag }];
					localStorage.setItem(
						`${STORAGE_PREFIX}${fingerprint}`,
						createPersistedUploadState(state),
					);
					update(fingerprint, {
						progress: Math.round((state.completedParts.length / state.partCount) * 100),
					});
				}
				await orpcClient.media.completeUploadSession({
					sessionId: state.sessionId,
					parts: state.completedParts,
				});
				localStorage.removeItem(`${STORAGE_PREFIX}${fingerprint}`);
				update(fingerprint, { status: "verifying", progress: 100, assetId: state.assetId });
			} catch (error) {
				const paused = controller.signal.aborted;
				update(fingerprint, {
					status: paused ? "paused" : "error",
					error: paused ? null : error instanceof Error ? error.message : "Upload failed",
				});
			} finally {
				abortControllers.current.delete(fingerprint);
			}
		},
		[update],
	);

	const addFiles = useCallback(
		(files: File[]) => {
			setItems((current) => [
				...current,
				...files.map((file) => {
					const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
					if (previewUrl) previewUrls.current.add(previewUrl);
					return {
						file,
						previewUrl,
						progress: 0,
						status: "idle" as const,
						assetId: null,
						error: null,
					};
				}),
			]);
			for (const file of files) void upload(file);
		},
		[upload],
	);

	const remove = useCallback(
		async (fingerprint: string) => {
			abortControllers.current.get(fingerprint)?.abort();
			const saved = parsePersistedUploadState(
				localStorage.getItem(`${STORAGE_PREFIX}${fingerprint}`),
			);
			if (saved)
				await orpcClient.media
					.abortUploadSession({ sessionId: saved.sessionId })
					.catch(() => undefined);
			localStorage.removeItem(`${STORAGE_PREFIX}${fingerprint}`);
			setItems((current) => {
				const removed = current.find((item) => getFileFingerprint(item.file) === fingerprint);
				if (removed?.previewUrl) {
					URL.revokeObjectURL(removed.previewUrl);
					previewUrls.current.delete(removed.previewUrl);
				}
				const next = current.filter((item) => getFileFingerprint(item.file) !== fingerprint);
				emitAssets(next);
				return next;
			});
		},
		[emitAssets],
	);

	return {
		items,
		addFiles,
		remove,
		pause: (fingerprint: string) => abortControllers.current.get(fingerprint)?.abort(),
		resume: (fingerprint: string) => {
			const item = items.find((candidate) => getFileFingerprint(candidate.file) === fingerprint);
			if (item) void upload(item.file);
		},
		retry: (fingerprint: string) => {
			const item = items.find((candidate) => getFileFingerprint(candidate.file) === fingerprint);
			if (item) void upload(item.file);
		},
	};
}
