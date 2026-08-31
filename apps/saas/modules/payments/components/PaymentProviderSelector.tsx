"use client";

import type { PaymentProviderName } from "@repo/payments/types";
import { cn } from "@repo/ui";
import { useTranslations } from "next-intl";

export function PaymentProviderSelector({
	name,
	providers,
	value,
	onValueChange,
	disabled = false,
}: {
	name: string;
	providers: PaymentProviderName[];
	value: PaymentProviderName | null;
	onValueChange: (provider: PaymentProviderName) => void;
	disabled?: boolean;
}) {
	const t = useTranslations("payments.providerSelector");

	return (
		<fieldset className="mt-4" disabled={disabled}>
			<legend className="mb-2 font-medium text-sm">{t("label")}</legend>
			<div className="gap-2 sm:grid-cols-3 grid">
				{providers.map((provider) => {
					const id = `${name}-${provider}`;
					return (
						<label
							key={provider}
							htmlFor={id}
							className={cn(
								"min-h-10 gap-2 px-3 py-2 text-sm flex cursor-pointer items-center rounded-lg border",
								value === provider && "border-primary bg-primary/5",
								disabled && "cursor-not-allowed opacity-60",
							)}
						>
							<input
								id={id}
								type="radio"
								name={name}
								value={provider}
								checked={value === provider}
								onChange={() => onValueChange(provider)}
								className="size-4 accent-primary"
							/>
							<span>{t(`providers.${provider}`)}</span>
						</label>
					);
				})}
			</div>
		</fieldset>
	);
}
