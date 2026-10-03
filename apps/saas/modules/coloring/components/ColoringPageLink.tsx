"use client";

import { Button } from "@repo/ui/components/button";
import { PaintbrushIcon } from "lucide-react";
import { useTranslations } from "next-intl";

import { coloringPageHref } from "../lib/navigation";

export function ColoringPageLink({
	assetId,
	guestJobId,
}: {
	assetId: string;
	guestJobId?: string;
}) {
	const t = useTranslations("coloring.handoff");
	return (
		<Button
			size="sm"
			variant="secondary"
			className="min-h-10"
			render={(props) => (
				<a {...props} href={coloringPageHref(assetId, guestJobId)}>
					{props.children}
				</a>
			)}
		>
			<PaintbrushIcon className="size-4" aria-hidden="true" />
			{t("action")}
		</Button>
	);
}
