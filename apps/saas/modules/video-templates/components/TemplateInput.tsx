"use client";

import { schedulePrivatePlaybackRefresh } from "@media/lib/private-playback-refresh";
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
	const [expiresAt, setExpiresAt] = useState<string | null>(null);
	const [status, setStatus] = useState<"idle" | "uploading" | "sealing" | "error">("idle");
	const lifecycle = useRef(0);
	const xhr = useRef<XMLHttpRequest | null>(null);
	const localPreview = useRef<string | null>(null);
	const previewRetry = useRef(false);
	useEffect(
		() => () => {
			lifecycle.current++;
			xhr.current?.abort();
			if (localPreview.current) URL.revokeObjectURL(localPreview.current);
		},
		[],
	);
	useEffect(() => {
		let active = true;
		previewRetry.current = false;
		setExpiresAt(null);
		if (!assetId) {
			setPreview(null);
			return;
		}
		void videoTemplatesApi.inputs
			.get({ assetId })
			.then((result) => {
				if (active) {
					setPreview(result.previewUrl);
					setExpiresAt(result.previewExpiresAt);
				}
			})
			.catch(() => {
				if (active) setPreview(null);
			});
		return () => {
			active = false;
		};
	}, [assetId]);
	useEffect(() => {
		let active = true;
		const cancel = schedulePrivatePlaybackRefresh(expiresAt ?? undefined, true, () => {
			if (assetId)
				void videoTemplatesApi.inputs
					.get({ assetId })
					.then((result) => {
						if (active) {
							setPreview(result.previewUrl);
							setExpiresAt(result.previewExpiresAt);
						}
					})
					.catch(() => {
						if (active) setPreview(null);
					});
		});
		return () => {
			active = false;
			cancel();
		};
	}, [assetId, expiresAt]);
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
		if (localPreview.current) URL.revokeObjectURL(localPreview.current);
		onChange(null);
		localPreview.current = URL.createObjectURL(file);
		setPreview(localPreview.current);
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
			onChange(result.assetId);
			setStatus("idle");
		} catch {
			if (lifecycle.current === revision) setStatus("error");
		} finally {
			if (lifecycle.current === revision) onBusy(false);
		}
	}
	return (
		<fieldset className="vt-input" disabled={disabled}>
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
							if (assetId && !previewRetry.current) {
								previewRetry.current = true;
								void videoTemplatesApi.inputs
									.get({ assetId })
									.then((result) => {
										setPreview(result.previewUrl);
										setExpiresAt(result.previewExpiresAt);
									})
									.catch(() => undefined);
							}
						}}
					/>
				) : (
					<span>
						<ImagePlusIcon aria-hidden />
						<strong>
							{t(
								assetId
									? subject
										? "privateImage"
										: "privatePhoto"
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
							? t(subject ? "privateImage" : "privatePhoto")
							: ""
						: t(status === "error" ? "uploadFailed" : status)}
				</span>
				{assetId && (
					<button
						type="button"
						aria-label={t(subject ? "removeImage" : "removePhoto", { role: t(`roles.${role}`) })}
						onClick={() => {
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
