"use client";

import type { PaymentProviderName } from "@repo/payments/types";
import { cn } from "@repo/ui";
import { useTranslations } from "next-intl";
import { useId } from "react";

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
	const groupId = `${name}-${useId()}`;

	return (
		<fieldset className="payment-provider-selector mt-3" disabled={disabled}>
			<legend className="mb-2 font-medium text-sm">{t("label")}</legend>
			<div className="gap-2 grid grid-cols-[repeat(auto-fit,minmax(110px,1fr))]">
				{providers.map((provider) => {
					const id = `${groupId}-${provider}`;
					return (
						<label
							key={provider}
							htmlFor={id}
							className={cn(
								"min-h-11 gap-2 px-3 py-2 text-sm flex cursor-pointer items-center rounded-xl border transition has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-primary",
								value === provider && "border-primary bg-primary/5",
								disabled && "cursor-not-allowed opacity-60",
							)}
						>
							<input
								id={id}
								type="radio"
								name={groupId}
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
