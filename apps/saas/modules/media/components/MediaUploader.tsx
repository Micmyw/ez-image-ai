"use client";

import { Button } from "@repo/ui/components/button";
import { type ClipboardEvent, useCallback } from "react";
import { useDropzone } from "react-dropzone";

import { useMediaUpload } from "../hooks/use-media-upload";
import { getFileFingerprint } from "../lib/upload-state";

export interface MediaUploaderProps {
	value?: string[];
	onChange: (assetIds: string[]) => void;
	multiple?: boolean;
}

export function MediaUploader({ onChange, multiple = true }: MediaUploaderProps) {
	const uploader = useMediaUpload(onChange);
	const addFiles = uploader.addFiles;
	const onDrop = useCallback(
		(files: File[]) => addFiles(multiple ? files : files.slice(0, 1)),
		[addFiles, multiple],
	);
	const { getInputProps, getRootProps, isDragActive } = useDropzone({
		onDrop,
		multiple,
		accept: {
			"image/jpeg": [".jpg", ".jpeg"],
			"image/png": [".png"],
			"image/webp": [".webp"],
			"video/mp4": [".mp4"],
			"video/webm": [".webm"],
			"video/quicktime": [".mov"],
		},
	});
	const onPaste = useCallback(
		(event: ClipboardEvent<HTMLDivElement>) => {
			const files = Array.from(event.clipboardData.files);
			if (files.length) addFiles(multiple ? files : files.slice(0, 1));
		},
		[addFiles, multiple],
	);
	return (
		<div className="space-y-3">
			<div
				{...getRootProps()}
				onPaste={onPaste}
				className="p-6 rounded-lg border border-dashed text-center focus-visible:ring-2 focus-visible:outline-none"
				aria-label="Upload images or video"
			>
				<input {...getInputProps()} />
				<p>{isDragActive ? "Drop files here" : "Drag files here, paste, or choose files"}</p>
				<p className="text-sm text-muted-foreground">Images up to 25 MB; videos up to 500 MB.</p>
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
									Pause
								</Button>
							)}
							{item.status === "paused" && (
								<Button type="button" variant="outline" onClick={() => uploader.resume(id)}>
									Resume
								</Button>
							)}
							{item.status === "error" && (
								<Button type="button" variant="outline" onClick={() => uploader.retry(id)}>
									Retry
								</Button>
							)}
							<Button type="button" variant="ghost" onClick={() => void uploader.remove(id)}>
								Remove
							</Button>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
