"use client";

import { ProgressProvider } from "@bprogress/next/app";
import { UpgradeProvider } from "@payments/components/UpgradeProvider";
import type { PropsWithChildren } from "react";

import { ArticleNavigationBoundary } from "../../public-content/components/ArticleNavigationBoundary";
import { ConversionTracking } from "./ConversionTracking";
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
			<ArticleNavigationBoundary />
			<PurchaseAttribution />
			<ConversionTracking />
			<AggregateTrafficTracking />
			<UpgradeProvider>{children}</UpgradeProvider>
		</ProgressProvider>
	);
}
import { AggregateTrafficTracking } from "./AggregateTrafficTracking";
