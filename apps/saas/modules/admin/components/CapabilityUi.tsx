"use client";

import { Button } from "@repo/ui/components/button";
import { Card } from "@repo/ui/components/card";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/components/select";
import { useTranslations } from "next-intl";
import Link from "next/link";
import type { ReactNode } from "react";

import { errorCode } from "../lib/capabilities-client";

export function CapabilitySection({
	title,
	description,
	children,
}: {
	title: string;
	description?: string;
	children: ReactNode;
}) {
	return (
		<Card className="space-y-5 p-6">
			<div>
				<h2 className="text-xl font-semibold">{title}</h2>
				{description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
			</div>
			{children}
		</Card>
	);
}

export function CapabilitySelect<T extends string>({
	label,
	value,
	options,
	onChange,
	disabled,
}: {
	label: string;
	value: T;
	options: Array<{ value: T; label: string }>;
	onChange: (value: T) => void;
	disabled?: boolean;
}) {
	return (
		<label className="space-y-1 text-sm block">
			<span>{label}</span>
			<Select
				value={value}
				onValueChange={(next) => next && onChange(next as T)}
				disabled={disabled}
			>
				<SelectTrigger aria-label={label}>
					<SelectValue>{options.find((option) => option.value === value)?.label}</SelectValue>
				</SelectTrigger>
				<SelectContent>
					{options.map((option) => (
						<SelectItem key={option.value} value={option.value}>
							{option.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</label>
	);
}

export function CapabilityError({
	error,
	uncertain = false,
}: {
	error: unknown;
	uncertain?: boolean;
}) {
	const t = useTranslations("admin.capabilities.common");
	if (!error) return null;
	return (
		<div role="alert" className="space-y-2 p-3 text-sm rounded-lg border border-destructive/30">
			<p>
				{t("error")} <code>{errorCode(error)}</code>
			</p>
			{uncertain && <p>{t("uncertain")}</p>}
			{uncertain && (
				<Link className="underline" href="/admin/agent#audit">
					{t("viewAudit")}
				</Link>
			)}
		</div>
	);
}

export function CapabilityLoading({
	loading,
	empty = false,
}: {
	loading: boolean;
	empty?: boolean;
}) {
	const t = useTranslations("admin.capabilities.common");
	if (!loading && !empty) return null;
	return (
		<p aria-live="polite" className="py-4 text-sm text-muted-foreground">
			{t(loading ? "loading" : "empty")}
		</p>
	);
}

export function CapabilityPager({
	page,
	total,
	pageSize = 20,
	onPage,
}: {
	page: number;
	total: number;
	pageSize?: number;
	onPage: (page: number) => void;
}) {
	const t = useTranslations("admin.capabilities.common");
	return (
		<div className="gap-3 flex items-center justify-between">
			<Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
				{t("previous")}
			</Button>
			<span className="text-sm">{t("page", { page, total })}</span>
			<Button
				variant="outline"
				size="sm"
				disabled={page * pageSize >= total}
				onClick={() => onPage(page + 1)}
			>
				{t("next")}
			</Button>
		</div>
	);
}
