"use client";

import { ArrowLeftRightIcon, CheckCircle2Icon, ImagePlusIcon, XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ChangeEvent } from "react";

import type { EffectRole } from "../lib/model";

export type PhotoSlot = {
	assetId: string | null;
	preview: string | null;
	previewExpiresAt?: string | null;
	status: "empty" | "uploading" | "sealing" | "sealed" | "error";
};
export const emptyPhotoSlot: PhotoSlot = { assetId: null, preview: null, status: "empty" };

export function DuoPhotoInputs({
	slots,
	maxBytes,
	disabled,
	onSelect,
	onClear,
	onSwap,
	onPreviewError,
	solo = false,
}: {
	solo?: boolean;
	slots: Record<EffectRole, PhotoSlot>;
	maxBytes: number;
	disabled: boolean;
	onSelect: (role: EffectRole, file: File) => void;
	onClear: (role: EffectRole) => void;
	onSwap: () => void;
	onPreviewError?: (role: EffectRole) => void;
}) {
	const t = useTranslations("videoEffects");
	return (
		<div className="ve-inputs">
			<div className="ve-photo-grid" data-solo={solo || undefined}>
				{(solo ? (["left"] as const) : (["left", "right"] as const)).map((role) => {
					const slot = slots[role];
					return (
						<fieldset key={role} className="ve-photo-slot" disabled={disabled}>
							<legend>
								<span>{role === "left" ? "01" : "02"}</span>
								{t(solo ? "soloSubject" : role)}
							</legend>
							<label className="ve-upload" htmlFor={`ve-upload-${role}`}>
								{slot.preview ? (
									<img
										src={slot.preview}
										alt={t("photoAlt", { role: t(solo ? "soloSubject" : role) })}
										onError={() => onPreviewError?.(role)}
									/>
								) : (
									<span className="ve-upload-empty">
										<ImagePlusIcon aria-hidden />
										<strong>{t("choosePhoto")}</strong>
										<small>{t("photoHint")}</small>
									</span>
								)}
								<input
									id={`ve-upload-${role}`}
									type="file"
									accept="image/jpeg,image/png,image/webp"
									aria-label={t("uploadLabel", { role: t(solo ? "soloSubject" : role) })}
									onChange={(event: ChangeEvent<HTMLInputElement>) => {
										const file = event.target.files?.[0];
										event.target.value = "";
										if (file) onSelect(role, file);
									}}
								/>
								{slot.preview && <span className="ve-replace">{t("replace")}</span>}
							</label>
							<div className="ve-slot-status" aria-live="polite">
								<span>
									{slot.status === "sealed" && <CheckCircle2Icon aria-hidden />}
									{t(`upload.${slot.status}`)}
								</span>
								{slot.status !== "empty" && (
									<button
										type="button"
										onClick={() => onClear(role)}
										aria-label={t("clearPhoto", { role: t(solo ? "soloSubject" : role) })}
									>
										<XIcon aria-hidden />
									</button>
								)}
							</div>
						</fieldset>
					);
				})}
			</div>
			{!solo && (
				<button
					type="button"
					className="ve-swap"
					disabled={disabled || !slots.left.assetId || !slots.right.assetId}
					onClick={onSwap}
				>
					<ArrowLeftRightIcon aria-hidden />
					{t("swap")}
				</button>
			)}
			<p className="ve-microcopy">{t("formats", { bytes: maxBytes.toLocaleString("en-US") })}</p>
		</div>
	);
}
