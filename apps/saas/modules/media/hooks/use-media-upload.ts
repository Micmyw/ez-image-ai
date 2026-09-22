"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useCallback, useEffect, useRef, useState } from "react";

import {
	uploadTemporaryReferenceFile,
	type TemporaryReferenceReceipt,
} from "../lib/temporary-reference-upload";
import {
	createPersistedUploadState,
	getFileFingerprint,
	getPendingPartNumbers,
	parsePersistedUploadState,
	type PersistedUploadState,
} from "../lib/upload-state";

export type MediaUploadStatus =
	| "idle"
	| "uploading"
	| "finalizing"
	| "paused"
	| "uploaded"
	| "error";

export interface MediaUploadItem {
	temporaryReference?: TemporaryReferenceReceipt;
	file: File;
	previewUrl: string | null;
	progress: number;
	status: MediaUploadStatus;
	assetId: string | null;
	error: string | null;
}

const STORAGE_PREFIX = "media-upload:";

export function useMediaUpload(
	onChange?: (assetIds: string[], reference?: TemporaryReferenceReceipt) => void,
	temporaryReference = false,
) {
	const [items, setItems] = useState<MediaUploadItem[]>([]);
	const abortControllers = useRef(new Map<string, AbortController>());
	const previewUrls = useRef(new Set<string>());
	const emittedAssetIds = useRef<string[]>([]);

	useEffect(
		() => () => {
			for (const previewUrl of previewUrls.current) URL.revokeObjectURL(previewUrl);
			for (const controller of abortControllers.current.values()) controller.abort();
		},
		[],
	);

	useEffect(() => {
		if (!onChange) return;
		const assetIds = items.flatMap((item) => (item.assetId ? [item.assetId] : []));
		if (
			assetIds.length === emittedAssetIds.current.length &&
			assetIds.every((assetId, index) => assetId === emittedAssetIds.current[index])
		) {
			return;
		}
		emittedAssetIds.current = assetIds;
		onChange(assetIds, items[0]?.temporaryReference);
	}, [items, onChange]);

	const update = useCallback((fingerprint: string, changes: Partial<MediaUploadItem>) => {
		setItems((current) =>
			current.map((item) =>
				getFileFingerprint(item.file) === fingerprint ? { ...item, ...changes } : item,
			),
		);
	}, []);

	const upload = useCallback(
		async (file: File) => {
			const fingerprint = getFileFingerprint(file);
			abortControllers.current.get(fingerprint)?.abort();
			const controller = new AbortController();
			abortControllers.current.set(fingerprint, controller);
			const isCurrent = () => abortControllers.current.get(fingerprint) === controller;
			const assertActive = () => {
				if (!isCurrent() || controller.signal.aborted)
					throw new DOMException("Upload canceled", "AbortError");
			};
			update(fingerprint, { status: "uploading", error: null });
			try {
				if (temporaryReference) {
					const receipt = await uploadTemporaryReferenceFile(file, controller.signal);
					assertActive();
					update(fingerprint, {
						status: "uploaded",
						progress: 100,
						assetId: receipt.assetId,
						temporaryReference: receipt,
					});
					return;
				}
				const saved = parsePersistedUploadState(
					localStorage.getItem(`${STORAGE_PREFIX}${fingerprint}`),
				);
				const session =
					saved ??
					(await orpcClient.media.createUploadSession({
						contentType: file.type,
						byteSize: file.size,
					}));
				assertActive();
				if ("method" in session && session.method === "PUT") {
					const response = await fetch(session.uploadUrl, {
						method: "PUT",
						body: file,
						headers: { "Content-Type": file.type },
						signal: controller.signal,
					});
					if (!response.ok) throw new Error("The image upload failed");
					assertActive();
					update(fingerprint, { status: "finalizing", progress: 100 });
					await orpcClient.media.completeUploadSession({ sessionId: session.sessionId });
					assertActive();
					update(fingerprint, { status: "uploaded", progress: 100, assetId: session.assetId });
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
					assertActive();
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
					assertActive();
					state.completedParts = [...state.completedParts, { partNumber, etag }];
					localStorage.setItem(
						`${STORAGE_PREFIX}${fingerprint}`,
						createPersistedUploadState(state),
					);
					update(fingerprint, {
						progress: Math.round((state.completedParts.length / state.partCount) * 100),
					});
				}
				assertActive();
				update(fingerprint, { status: "finalizing", progress: 100 });
				await orpcClient.media.completeUploadSession({
					sessionId: state.sessionId,
					parts: state.completedParts,
				});
				assertActive();
				localStorage.removeItem(`${STORAGE_PREFIX}${fingerprint}`);
				update(fingerprint, { status: "uploaded", progress: 100, assetId: state.assetId });
			} catch (error) {
				if (!isCurrent()) return;
				const paused = controller.signal.aborted;
				update(fingerprint, {
					status: paused ? "paused" : "error",
					error: paused ? null : error instanceof Error ? error.message : "Upload failed",
				});
			} finally {
				if (isCurrent()) abortControllers.current.delete(fingerprint);
			}
		},
		[update, temporaryReference],
	);

	const addFiles = useCallback(
		(files: File[]) => {
			const added = files.map((file) => {
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
			});
			setItems((current) => [...current, ...added]);
			for (const file of files) void upload(file);
		},
		[upload],
	);

	const remove = useCallback(
		async (fingerprint: string) => {
			abortControllers.current.get(fingerprint)?.abort();
			abortControllers.current.delete(fingerprint);
			const saved = parsePersistedUploadState(
				localStorage.getItem(`${STORAGE_PREFIX}${fingerprint}`),
			);
			localStorage.removeItem(`${STORAGE_PREFIX}${fingerprint}`);
			const removed = items.find((item) => getFileFingerprint(item.file) === fingerprint);
			if (removed?.previewUrl) {
				URL.revokeObjectURL(removed.previewUrl);
				previewUrls.current.delete(removed.previewUrl);
			}
			setItems((current) => {
				return current.filter((item) => getFileFingerprint(item.file) !== fingerprint);
			});
			if (saved)
				await orpcClient.media
					.abortUploadSession({ sessionId: saved.sessionId })
					.catch(() => undefined);
		},
		[items],
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
