"use client";

import { useTranslations } from "next-intl";

export type ImageFundingSource = "CREDITS" | "IMAGE_PASS";

export function ImageFundingSelector({
	value,
	available,
	reserved = 0,
	failed = false,
	onRefresh,
	disabled = false,
	onChange,
}: {
	value: ImageFundingSource;
	available?: number;
	reserved?: number;
	failed?: boolean;
	onRefresh?: () => void;
	disabled?: boolean;
	onChange: (value: ImageFundingSource) => void;
}) {
	const t = useTranslations("imagePass");
	if (value === "CREDITS" && (available ?? 0) < 1 && reserved < 1) return null;

	return (
		<fieldset className="my-2 min-w-0" data-test="image-funding-selector" disabled={disabled}>
			<legend className="sr-only">{t("fundingLabel")}</legend>
			<div className="gap-x-4 gap-y-1 text-xs flex flex-wrap items-center text-[#b7acbf]">
				<span aria-hidden="true">{t("fundingLabel")}</span>
				<label className="min-h-8 gap-2 text-white flex cursor-pointer items-center">
					<input
						type="radio"
						name="image-funding"
						value="CREDITS"
						checked={value === "CREDITS"}
						onChange={() => onChange("CREDITS")}
						className="accent-violet-400"
					/>
					{t("fundingCredits")}
				</label>
				<label className="min-h-8 gap-2 text-white flex cursor-pointer items-center">
					<input
						type="radio"
						name="image-funding"
						value="IMAGE_PASS"
						checked={value === "IMAGE_PASS"}
						disabled={failed || available === undefined || available < 1}
						onChange={() => onChange("IMAGE_PASS")}
						className="accent-violet-400"
					/>
					{failed
						? t("balanceError")
						: available === undefined
							? t("fundingLoading")
							: t("fundingPasses", { count: available })}
				</label>
				{reserved > 0 && <span>{t("fundingReserved", { count: reserved })}</span>}
				{failed && onRefresh && (
					<button
						type="button"
						onClick={onRefresh}
						className="min-h-8 text-violet-200 underline underline-offset-4"
					>
						{t("retryBalance")}
					</button>
				)}
			</div>
			{value === "IMAGE_PASS" && !failed && available !== undefined && available < 1 && (
				<p className="mt-1 text-xs leading-5 text-[#b7acbf]" aria-live="polite">
					{t("fundingExhausted")}
				</p>
			)}
		</fieldset>
	);
}
