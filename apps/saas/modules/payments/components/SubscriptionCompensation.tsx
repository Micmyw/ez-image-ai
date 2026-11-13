"use client";

import { Button } from "@repo/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/components/dialog";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";

import { upgradeHref } from "../lib/upgrade-selection";

export function SubscriptionCompensationDialog({
	ownerId,
	assetId,
	enabled,
}: {
	ownerId: string | null;
	assetId: string;
	enabled: boolean;
}) {
	const t = useTranslations("payments.technicalCompensation");
	const locale = useLocale();
	const format = useFormatter();
	const client = useQueryClient();
	const [dismissedIds, setDismissedIds] = useState<string[]>([]);
	const { data } = useQuery({
		queryKey: ["subscription-compensation-claim", ownerId, assetId],
		queryFn: async () => {
			const result = await orpcClient.payments.claimSubscriptionCompensation({ assetId });
			void client.invalidateQueries({ queryKey: ["subscription-compensation", ownerId] });
			return result;
		},
		enabled: enabled && !!ownerId && !!assetId,
		staleTime: Infinity,
		retry: 1,
	});
	const offer = data?.offer;
	const open =
		enabled &&
		!!ownerId &&
		!!offer &&
		!offer.dismissed &&
		!dismissedIds.includes(offer.id) &&
		Date.parse(offer.expiresAt) > Date.now();
	const dismiss = () => {
		if (!offer) return;
		setDismissedIds((ids) => [...ids, offer.id]);
		client.setQueriesData<{ offer: typeof offer | null }>(
			{ queryKey: ["subscription-compensation-claim", ownerId] },
			(cached) =>
				cached?.offer?.id === offer.id ? { offer: { ...cached.offer, dismissed: true } } : cached,
		);
		void orpcClient.payments.dismissSubscriptionCompensation({}).catch(() => undefined);
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) dismiss();
			}}
		>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{t("title")}</DialogTitle>
					<DialogDescription>{t("description")}</DialogDescription>
				</DialogHeader>
				<p className="text-sm">{t("terms")}</p>
				{offer && (
					<p className="text-sm text-muted-foreground">
						{t("expires", {
							date: format.dateTime(new Date(offer.expiresAt), {
								dateStyle: "medium",
								timeStyle: "short",
							}),
						})}
					</p>
				)}
				<DialogFooter>
					<Button type="button" variant="ghost" onClick={dismiss}>
						{t("later")}
					</Button>
					<Button
						onClick={dismiss}
						render={(props) => (
							<Link
								{...props}
								href={upgradeHref({ planId: "creator", interval: "month" }, locale)}
							/>
						)}
					>
						{t("viewPlans")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function SubscriptionCompensationBanner({ ownerId }: { ownerId: string }) {
	const t = useTranslations("payments.technicalCompensation");
	const format = useFormatter();
	const { data } = useQuery({
		...orpc.payments.getSubscriptionCompensation.queryOptions({ input: {} }),
		queryKey: ["subscription-compensation", ownerId],
		staleTime: 30_000,
		retry: false,
	});
	const offer = data?.offer;
	if (!offer || Date.parse(offer.expiresAt) <= Date.now()) return null;
	return (
		<aside
			className="mb-4 p-4 text-sm rounded-xl border border-primary/30 bg-primary/5"
			data-test="subscription-compensation"
		>
			<p className="font-semibold">{t("banner")}</p>
			<p className="mt-1">{t("terms")}</p>
			<p className="mt-1 text-muted-foreground">
				{t("expires", {
					date: format.dateTime(new Date(offer.expiresAt), {
						dateStyle: "medium",
						timeStyle: "short",
					}),
				})}
			</p>
		</aside>
	);
}
