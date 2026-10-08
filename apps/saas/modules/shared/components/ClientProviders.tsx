"use client";

import { ProgressProvider } from "@bprogress/next/app";
import { UpgradeProvider } from "@payments/components/UpgradeProvider";
import type { PropsWithChildren } from "react";

import { PurchaseAttribution } from "./PurchaseAttribution";

export function ClientProviders({ children }: PropsWithChildren) {
	return (
		<ProgressProvider
			height="4px"
			color="var(--color-primary)"
			options={{ showSpinner: false }}
			shallowRouting
			delay={250}
		>
			<PurchaseAttribution />
			<UpgradeProvider>{children}</UpgradeProvider>
		</ProgressProvider>
	);
}
