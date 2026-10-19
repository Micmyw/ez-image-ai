"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";

export type ImageFundingSource = "CREDITS" | "IMAGE_PASS";

export function ImageFundingSelector({
	value,
	available,
	failed = false,
	onRefresh,
	disabled = false,
	onChange,
}: {
	value: ImageFundingSource;
	available?: number;
	failed?: boolean;
	onRefresh?: () => void;
	disabled?: boolean;
	onChange: (value: ImageFundingSource) => void;
}) {
	const t = useTranslations("imagePass");
	return (
		<fieldset
			className="mt-3 mb-3 border-white/10 bg-white/[0.025] p-3 rounded-xl border"
			disabled={disabled}
		>
			<legend className="px-1 text-xs font-semibold text-violet-200">{t("fundingLabel")}</legend>
			<div className="gap-x-5 gap-y-3 text-sm text-white flex flex-wrap">
				<label className="min-h-9 gap-2 flex cursor-pointer items-center">
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
				<label className="min-h-9 gap-2 flex cursor-pointer items-center">
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
				<Link
					href="/image-pass"
					className="min-h-9 text-xs font-semibold text-violet-200 ml-auto flex items-center underline underline-offset-4"
				>
					{t("buyMore")}
				</Link>
			</div>
			{failed && onRefresh && (
				<button
					type="button"
					onClick={onRefresh}
					className="mt-2 min-h-9 text-xs text-violet-200 underline underline-offset-4"
				>
					{t("retryBalance")}
				</button>
			)}
			<p className="mt-1 text-xs leading-5 text-[#b7acbf]" aria-live="polite">
				{value === "IMAGE_PASS"
					? available !== undefined && available < 1
						? t("fundingEmpty")
						: t("fundingPolicy")
					: t("fundingSeparate")}
			</p>
		</fieldset>
	);
}
