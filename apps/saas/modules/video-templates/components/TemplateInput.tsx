"use client";

import type { SourceTemplateKey, SourceTemplateRole } from "@repo/config/video-template-library";
import { ImagePlusIcon, XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { videoTemplatesApi } from "../lib/api";
import { TemplateRoleLabel } from "./TemplateSetup";

export function TemplateInput({
	templateKey,
	role,
	assetId,
	maximumBytes,
	disabled,
	onChange,
	onBusy,
	preset,
}: {
	templateKey: SourceTemplateKey;
	role: SourceTemplateRole;
	assetId?: string;
	maximumBytes: number;
	disabled: boolean;
	onChange: (id: string | null) => void;
	onBusy: (busy: boolean) => void;
	preset?: import("@repo/config/video-template-library").SourceTemplateChoices["preset"];
}) {
	const t = useTranslations("videoTemplates");
	const subject = role === "subject";
	const [preview, setPreview] = useState<string | null>(null);
	const [status, setStatus] = useState<"idle" | "uploading" | "sealing" | "error">("idle");
	const [progress, setProgress] = useState(0);
	const [previewFailed, setPreviewFailed] = useState(false);
	const lifecycle = useRef(0);
	const previewRequest = useRef(0);
	const currentAsset = useRef(assetId);
	currentAsset.current = assetId;
	const xhr = useRef<XMLHttpRequest | null>(null);
	const localPreview = useRef<{ url: string; assetId: string | null } | null>(null);
	const previewRetry = useRef(false);
	useEffect(
		() => () => {
			lifecycle.current++;
			previewRequest.current++;
			xhr.current?.abort();
			if (localPreview.current) URL.revokeObjectURL(localPreview.current.url);
		},
		[],
	);
	useEffect(() => {
		let active = true;
		const requestRevision = ++previewRequest.current;
		previewRetry.current = false;
		setPreviewFailed(false);
		// Upload start clears the previous asset ID, and completion supplies the new ID.
		// Neither transition should replace the owner's immediate local thumbnail.
		if (localPreview.current?.assetId === (assetId ?? null)) {
			setPreview(localPreview.current!.url);
			return;
		}
		if (localPreview.current) {
			URL.revokeObjectURL(localPreview.current.url);
			localPreview.current = null;
		}
		setPreview(null);
		if (!assetId) {
			return;
		}
		void videoTemplatesApi.inputs
			.get({ assetId })
			.then((result) => {
				if (active && requestRevision === previewRequest.current) {
					setPreview(result.previewUrl);
					setPreviewFailed(!result.previewUrl);
				}
			})
			.catch(() => {
				if (active && requestRevision === previewRequest.current) setPreviewFailed(true);
			});
		return () => {
			active = false;
		};
	}, [assetId]);
	async function refreshPreview() {
		if (!assetId) return;
		const revision = ++previewRequest.current;
		setPreviewFailed(false);
		try {
			const result = await videoTemplatesApi.inputs.get({ assetId });
			if (revision !== previewRequest.current || currentAsset.current !== assetId) return;
			setPreview(result.previewUrl);
			setPreviewFailed(!result.previewUrl);
		} catch {
			if (revision === previewRequest.current) setPreviewFailed(true);
		}
	}
	// A decoded still image needs no timer-based URL renewal. Renew only on load failure.
	async function select(file: File) {
		const revision = ++lifecycle.current;
		if (
			!["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
			file.size <= 0 ||
			file.size > maximumBytes
		) {
			setStatus("error");
			return;
		}
		xhr.current?.abort();
		previewRequest.current++;
		if (localPreview.current) URL.revokeObjectURL(localPreview.current.url);
		localPreview.current = { url: URL.createObjectURL(file), assetId: null };
		onChange(null);
		setPreview(localPreview.current.url);
		setPreviewFailed(false);
		setProgress(0);
		setStatus("uploading");
		onBusy(true);
		try {
			const session = await videoTemplatesApi.uploads.create({
				templateKey,
				contentType: file.type as "image/jpeg" | "image/png" | "image/webp",
				byteSize: file.size,
			});
			if (lifecycle.current !== revision) return;
			await new Promise<void>((resolve, reject) => {
				const transfer = new XMLHttpRequest();
				xhr.current = transfer;
				transfer.open("PUT", session.uploadUrl);
				transfer.setRequestHeader("Content-Type", file.type);
				transfer.upload.onprogress = (event) => {
					if (lifecycle.current === revision && event.lengthComputable)
						setProgress(Math.round((event.loaded / event.total) * 100));
				};
				transfer.onload = () =>
					transfer.status >= 200 && transfer.status < 300
						? resolve()
						: reject(new Error("UPLOAD_FAILED"));
				transfer.onerror = transfer.onabort = () => reject(new Error("UPLOAD_FAILED"));
				transfer.send(file);
			});
			if (lifecycle.current !== revision) return;
			setStatus("sealing");
			const result = await videoTemplatesApi.uploads.complete({ sessionId: session.sessionId });
			if (lifecycle.current !== revision) return;
			if (localPreview.current) localPreview.current.assetId = result.assetId;
			onChange(result.assetId);
			setStatus("idle");
		} catch {
			if (lifecycle.current === revision) setStatus("error");
		} finally {
			if (lifecycle.current === revision) onBusy(false);
		}
	}
	return (
		<fieldset
			className="vt-input"
			disabled={disabled || status === "uploading" || status === "sealing"}
		>
			<legend>
				<TemplateRoleLabel templateKey={templateKey} role={role} preset={preset} />
			</legend>
			<label className="vt-upload" htmlFor={`vt-upload-${role}`}>
				{preview ? (
					<img
						src={preview}
						alt={t(subject ? "privateImage" : "privatePhoto")}
						data-clarity-mask="true"
						onError={() => {
							setPreview(null);
							setPreviewFailed(true);
							if (assetId && !previewRetry.current) {
								previewRetry.current = true;
								void refreshPreview();
							}
						}}
					/>
				) : (
					<span>
						<ImagePlusIcon aria-hidden />
						<strong>
							{t(
								assetId
									? previewFailed
										? "previewFailed"
										: "loadingPhoto"
									: subject
										? "chooseImage"
										: "choosePhoto",
							)}
						</strong>
					</span>
				)}
				<input
					id={`vt-upload-${role}`}
					type="file"
					accept="image/jpeg,image/png,image/webp"
					aria-label={`${t(subject ? "chooseImage" : "choosePhoto")} · ${t(`roles.${role}`)}`}
					onChange={(event) => {
						const file = event.target.files?.[0];
						event.target.value = "";
						if (file) void select(file);
					}}
				/>
				{preview && (
					<span className="vt-replace">{t(subject ? "replaceImage" : "replacePhoto")}</span>
				)}
			</label>
			<div className="vt-input-status" aria-live="polite">
				<span>
					{status === "idle"
						? assetId
							? t("photoReady")
							: ""
						: status === "uploading"
							? t("uploadProgress", { progress })
							: t(status === "error" ? "uploadFailed" : status)}
				</span>
				{previewFailed && assetId && (
					<button type="button" onClick={() => void refreshPreview()}>
						{t("retryPreview")}
					</button>
				)}
				{assetId && (
					<button
						type="button"
						aria-label={t(subject ? "removeImage" : "removePhoto", { role: t(`roles.${role}`) })}
						onClick={() => {
							previewRequest.current++;
							if (localPreview.current) URL.revokeObjectURL(localPreview.current.url);
							localPreview.current = null;
							onChange(null);
							setPreview(null);
						}}
					>
						<XIcon aria-hidden />
					</button>
				)}
			</div>
		</fieldset>
	);
}
