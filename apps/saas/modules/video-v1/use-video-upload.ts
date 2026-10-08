"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { videoApi } from "./api";
import type { VideoErrorKey } from "./model";

export type VideoUpload = {
	status: "idle" | "uploading" | "sealing" | "sealed" | "error";
	progress: number;
	preview: string | null;
	assetId: string | null;
	error: VideoErrorKey | null;
};
const empty: VideoUpload = {
	status: "idle",
	progress: 0,
	preview: null,
	assetId: null,
	error: null,
};

export function useVideoUpload(maxBytes: number) {
	const [upload, setUpload] = useState<VideoUpload>(empty);
	const active = useRef(0);
	const xhr = useRef<XMLHttpRequest | null>(null);
	const preview = useRef<string | null>(null);
	const clear = useCallback(() => {
		active.current++;
		xhr.current?.abort();
		if (preview.current) URL.revokeObjectURL(preview.current);
		preview.current = null;
		setUpload(empty);
	}, []);
	useEffect(
		() => () => {
			active.current++;
			xhr.current?.abort();
			if (preview.current) URL.revokeObjectURL(preview.current);
		},
		[],
	);
	async function select(file: File) {
		clear();
		const revision = active.current;
		if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
			setUpload({ ...empty, error: "invalidImage", status: "error" });
			return;
		}
		if (file.size <= 0 || file.size > Math.min(maxBytes, 10 * 1024 * 1024)) {
			setUpload({ ...empty, error: "imageTooLarge", status: "error" });
			return;
		}
		preview.current = URL.createObjectURL(file);
		setUpload({ ...empty, status: "uploading", preview: preview.current });
		try {
			const session = await videoApi.uploads.create({
				contentType: file.type as "image/jpeg" | "image/png" | "image/webp",
				byteSize: file.size,
			});
			if (active.current !== revision) return;
			await new Promise<void>((resolve, reject) => {
				const transfer = new XMLHttpRequest();
				xhr.current = transfer;
				transfer.open("PUT", session.uploadUrl);
				transfer.setRequestHeader("Content-Type", file.type);
				transfer.upload.onprogress = (event) => {
					if (event.lengthComputable && active.current === revision)
						setUpload((current) => ({
							...current,
							progress: Math.round((event.loaded / event.total) * 100),
						}));
				};
				transfer.onload = () =>
					transfer.status >= 200 && transfer.status < 300
						? resolve()
						: reject(new Error("UPLOAD_FAILED"));
				transfer.onerror = transfer.onabort = () => reject(new Error("UPLOAD_FAILED"));
				transfer.send(file);
			});
			if (active.current !== revision) return;
			setUpload((current) => ({ ...current, status: "sealing", progress: 100 }));
			const sealed = await videoApi.uploads.complete({ sessionId: session.sessionId });
			if (active.current !== revision) return;
			setUpload((current) => ({ ...current, status: "sealed", assetId: sealed.assetId }));
		} catch {
			if (active.current === revision)
				setUpload((current) => ({ ...current, status: "error", error: "upload" }));
		}
	}
	return { upload, select, clear };
}
