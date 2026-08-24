"use client";

import { getPublicConfig } from "@repo/config/client";
import { Button } from "@repo/ui/components/button";
import { useTranslations } from "next-intl";
import { type ClipboardEvent, useCallback } from "react";
import { useDropzone } from "react-dropzone";

import { useMediaUpload } from "../hooks/use-media-upload";
import { getFileFingerprint } from "../lib/upload-state";

const publicProductConfig = getPublicConfig();
const ezPicImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

export function filterEzPicImageFiles(files: File[]): File[] {
	return files.filter(
		(file) =>
			file.size > 0 &&
			file.size <= publicProductConfig.uploadLimits.imageBytes &&
			ezPicImageTypes.has(file.type),
	);
}

export interface MediaUploaderProps {
	value?: string[];
	onChange: (assetIds: string[]) => void;
	multiple?: boolean;
}

export function MediaUploader({ onChange, multiple = true }: MediaUploaderProps) {
	const t = useTranslations("media.uploader");
	const uploader = useMediaUpload(onChange);
	const addFiles = uploader.addFiles;
	const addImageFiles = useCallback(
		(files: File[]) => {
			const acceptedFiles = filterEzPicImageFiles(files);
			if (acceptedFiles.length) addFiles(multiple ? acceptedFiles : acceptedFiles.slice(0, 1));
		},
		[addFiles, multiple],
	);
	const { getInputProps, getRootProps, isDragActive } = useDropzone({
		onDrop: addImageFiles,
		multiple,
		maxSize: publicProductConfig.uploadLimits.imageBytes,
		accept: {
			"image/jpeg": [".jpg", ".jpeg"],
			"image/png": [".png"],
			"image/webp": [".webp"],
		},
	});
	const onPaste = useCallback(
		(event: ClipboardEvent<HTMLDivElement>) => {
			const files = Array.from(event.clipboardData.files);
			if (!files.length) return;
			event.preventDefault();
			addImageFiles(files);
		},
		[addImageFiles],
	);
	return (
		<div className="space-y-3">
			<div
				{...getRootProps()}
				onPaste={onPaste}
				className="p-6 rounded-lg border border-dashed text-center focus-visible:ring-2 focus-visible:outline-none"
				aria-label={t("label")}
			>
				<input {...getInputProps()} />
				<p>{isDragActive ? t("active") : t("idle")}</p>
				<p className="text-sm text-muted-foreground">{t("limit")}</p>
			</div>
			<ul className="space-y-2" aria-live="polite">
				{uploader.items.map((item) => {
					const id = getFileFingerprint(item.file);
					return (
						<li key={id} className="gap-3 p-3 flex items-center rounded-md border">
							{item.previewUrl && (
								<img src={item.previewUrl} alt="" className="size-12 rounded object-cover" />
							)}
							<div className="min-w-0 flex-1">
								<p className="truncate">{item.file.name}</p>
								<p className="text-sm text-muted-foreground">
									{item.status} · {item.progress}%
								</p>
								{item.error && (
									<p role="alert" className="text-sm text-destructive">
										{item.error}
									</p>
								)}
							</div>
							{item.status === "uploading" && (
								<Button type="button" variant="outline" onClick={() => uploader.pause(id)}>
									{t("pause")}
								</Button>
							)}
							{item.status === "paused" && (
								<Button type="button" variant="outline" onClick={() => uploader.resume(id)}>
									{t("resume")}
								</Button>
							)}
							{item.status === "error" && (
								<Button type="button" variant="outline" onClick={() => uploader.retry(id)}>
									{t("retry")}
								</Button>
							)}
							<Button type="button" variant="ghost" onClick={() => void uploader.remove(id)}>
								{t("remove")}
							</Button>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
