"use client";

import { getPublicConfig } from "@repo/config/client";
import { Button } from "@repo/ui/components/button";
import { UploadCloudIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ClipboardEvent, useCallback, useEffect } from "react";
import { useDropzone } from "react-dropzone";

import { useMediaUpload } from "../hooks/use-media-upload";
import { getFileFingerprint } from "../lib/upload-state";

const publicProductConfig = getPublicConfig();
const ezPicImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

export function filterEzPicImageFiles(
	files: File[],
	maximumImageBytes = publicProductConfig.uploadLimits.imageBytes,
): File[] {
	const limit = Math.min(maximumImageBytes, publicProductConfig.uploadLimits.imageBytes);
	return files.filter(
		(file) => file.size > 0 && file.size <= limit && ezPicImageTypes.has(file.type),
	);
}

export interface MediaUploaderProps {
	value?: string[];
	onChange: (assetIds: string[]) => void;
	onPendingChange?: (pending: boolean) => void;
	multiple?: boolean;
	maximumImageBytes?: number;
	compact?: boolean;
}

export function MediaUploader({
	onChange,
	onPendingChange,
	multiple = true,
	maximumImageBytes = publicProductConfig.uploadLimits.imageBytes,
	compact = false,
}: MediaUploaderProps) {
	const t = useTranslations("media.uploader");
	const studio = useTranslations("studio");
	const uploader = useMediaUpload(onChange);
	const addFiles = uploader.addFiles;
	const pending = uploader.items.some((item) => item.status !== "uploaded");
	useEffect(() => onPendingChange?.(pending), [onPendingChange, pending]);
	const imageByteLimit = Math.min(maximumImageBytes, publicProductConfig.uploadLimits.imageBytes);
	const addImageFiles = useCallback(
		(files: File[]) => {
			const acceptedFiles = filterEzPicImageFiles(files, imageByteLimit);
			if (acceptedFiles.length) {
				onPendingChange?.(true);
				addFiles(multiple ? acceptedFiles : acceptedFiles.slice(0, 1));
			}
		},
		[addFiles, imageByteLimit, multiple, onPendingChange],
	);
	const { getInputProps, getRootProps, isDragActive } = useDropzone({
		onDrop: addImageFiles,
		multiple,
		maxSize: imageByteLimit,
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
				className={
					compact
						? "studio-upload min-h-32 p-3 text-xs rounded-xl border border-dashed text-center focus-visible:ring-2 focus-visible:outline-none"
						: "p-6 rounded-lg border border-dashed text-center focus-visible:ring-2 focus-visible:outline-none"
				}
				aria-label={t("label")}
			>
				<input {...getInputProps()} />
				{compact && <UploadCloudIcon className="mb-3 size-6 text-violet-300 mx-auto" aria-hidden />}
				<p>{isDragActive ? t("active") : compact ? studio("upload") : t("idle")}</p>
				<p
					className={
						compact ? "mt-2 text-[10px] text-muted-foreground" : "text-sm text-muted-foreground"
					}
				>
					{t("limit", { megabytes: Math.round(imageByteLimit / 1024 / 1024) })}
				</p>
			</div>
			<ul className="space-y-2" aria-live="polite">
				{uploader.items.map((item) => {
					const id = getFileFingerprint(item.file);
					return (
						<li
							key={id}
							className={
								compact
									? "gap-2 p-2 grid grid-cols-2 rounded-md border"
									: "gap-3 p-3 flex items-center rounded-md border"
							}
						>
							{item.previewUrl && !compact && (
								<img src={item.previewUrl} alt="" className="size-12 rounded object-cover" />
							)}
							<div className={compact ? "min-w-0 col-span-2" : "min-w-0 flex-1"}>
								<p className="truncate">{item.file.name}</p>
								<p className="text-sm text-muted-foreground">
									{t(`status.${item.status}`)} · {item.progress}%
								</p>
								{item.error && (
									<p role="alert" className="text-sm break-words text-destructive">
										{item.error}
									</p>
								)}
							</div>
							{item.status === "uploading" && (
								<Button
									size={compact ? "sm" : undefined}
									className={compact ? "min-h-8 px-1 h-auto whitespace-normal" : undefined}
									type="button"
									variant="outline"
									onClick={() => uploader.pause(id)}
								>
									{t("pause")}
								</Button>
							)}
							{item.status === "paused" && (
								<Button
									size={compact ? "sm" : undefined}
									className={compact ? "min-h-8 px-1 h-auto whitespace-normal" : undefined}
									type="button"
									variant="outline"
									onClick={() => uploader.resume(id)}
								>
									{t("resume")}
								</Button>
							)}
							{item.status === "error" && (
								<Button
									size={compact ? "sm" : undefined}
									className={compact ? "min-h-8 px-1 h-auto whitespace-normal" : undefined}
									type="button"
									variant="outline"
									onClick={() => uploader.retry(id)}
								>
									{t("retry")}
								</Button>
							)}
							<Button
								size={compact ? "sm" : undefined}
								className={compact ? "min-h-8 px-1 h-auto whitespace-normal" : undefined}
								type="button"
								variant="ghost"
								onClick={() => void uploader.remove(id)}
							>
								{t("remove")}
							</Button>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
