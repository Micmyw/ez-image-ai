"use client";
import { useSession } from "@auth/hooks/use-session";
import { useActiveOrganization } from "@organizations/hooks/use-active-organization";
import { useOrganizationListQuery } from "@organizations/lib/api";
import { usePlanData } from "@payments/hooks/plan-data";
import { usePurchases } from "@payments/hooks/purchases";
import { config as authConfig } from "@repo/auth/config";
import { config as paymentsConfig } from "@repo/payments/config";
import { cn, mergeTriggerProps } from "@repo/ui";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@repo/ui/components/tooltip";
import { useRouter } from "@shared/hooks/router";
import { clearCache } from "@shared/lib/cache";
import { ChevronsUpDownIcon, PlusIcon, UserIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useMemo } from "react";

import { OrganizationLogo } from "./OrganizationLogo";

function PersonalAccountIcon({ className }: { className?: string }) {
	return (
		<span
			className={cn(
				"size-8 flex shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary",
				className,
			)}
		>
			<UserIcon className="size-4" />
		</span>
	);
}

export function OrganzationSelect({
	className,
	collapsed = false,
}: {
	className?: string;
	collapsed?: boolean;
}) {
	const t = useTranslations();
	const { user } = useSession();
	const router = useRouter();
	const { activeOrganization, setActiveOrganization } = useActiveOrganization();
	const { data: allOrganizations } = useOrganizationListQuery();
	const { planData } = usePlanData();
	const { activePlan: orgActivePlan } = usePurchases(activeOrganization?.id);
	const { activePlan: userActivePlan } = usePurchases();

	const listOrganizations = useMemo(() => {
		if (!allOrganizations) {
			return;
		}
		if (!activeOrganization?.id) {
			return allOrganizations;
		}
		return allOrganizations.map((organization) => {
			if (organization.id !== activeOrganization.id) {
				return organization;
			}
			return { ...organization, name: activeOrganization.name, logo: activeOrganization.logo };
		});
	}, [
		allOrganizations,
		activeOrganization?.id,
		activeOrganization?.name,
		activeOrganization?.logo,
	]);

	if (!user) {
		return null;
	}

	const getPlanTitle = (planId: string | undefined) => {
		if (!planId) {
			return null;
		}
		const plan = planData[planId as keyof typeof planData];
		return plan?.title ?? null;
	};

	const triggerClassName = cn(
		"gap-3 flex w-full items-center justify-between rounded-lg border border-border bg-card text-left transition-colors outline-none",
		collapsed ? "p-1.5 justify-center" : "py-1.5 pr-2.5 pl-1.5",
	);

	const triggerBody = (
		<>
			<div
				className={cn("gap-3 flex items-center overflow-hidden", {
					"justify-center": collapsed,
				})}
			>
				{activeOrganization ? (
					<>
						<OrganizationLogo
							name={activeOrganization.name}
							logoUrl={activeOrganization.logo}
							className={cn("size-8 shrink-0 rounded-md")}
						/>
						{!collapsed && (
							<div className="min-w-0 gap-1 flex flex-1 flex-col leading-none">
								<span className="text-sm font-semibold leading-4 truncate text-foreground">
									{activeOrganization.name}
								</span>
								{paymentsConfig.billingAttachedTo === "organization" && orgActivePlan && (
									<span className="text-xs font-medium leading-3 truncate text-primary">
										{getPlanTitle(orgActivePlan.id)}
									</span>
								)}
							</div>
						)}
					</>
				) : (
					<>
						<PersonalAccountIcon />
						{!collapsed && (
							<div className="min-w-0 flex flex-1 flex-col leading-none">
								<span className="text-sm font-semibold leading-4 truncate text-foreground">
									{t("organizations.organizationSelect.personalAccount")}
								</span>
								{paymentsConfig.billingAttachedTo === "user" && userActivePlan && (
									<span className="text-xs font-medium leading-3 truncate text-primary">
										{getPlanTitle(userActivePlan.id)}
									</span>
								)}
							</div>
						)}
					</>
				)}
			</div>

			{!collapsed && <ChevronsUpDownIcon className="size-4 shrink-0 text-muted-foreground" />}
		</>
	);

	const menuTrigger = (
		<DropdownMenuTrigger
			render={(mp) => (
				<button type="button" {...mp} className={cn(mp.className, triggerClassName)}>
					{triggerBody}
				</button>
			)}
		/>
	);

	const triggerContent = collapsed ? (
		<Tooltip>
			<TooltipTrigger
				render={(tp) => (
					<DropdownMenuTrigger
						render={(mp) => {
							const m = mergeTriggerProps(tp, mp);
							return (
								<button
									type="button"
									{...m}
									className={cn(m.className as string | undefined, triggerClassName)}
								>
									{triggerBody}
								</button>
							);
						}}
					/>
				)}
			/>
			<TooltipContent side="right">
				{activeOrganization
					? activeOrganization.name
					: t("organizations.organizationSelect.personalAccount")}
			</TooltipContent>
		</Tooltip>
	) : (
		menuTrigger
	);

	const dropdownContent = (
		<DropdownMenuContent
			side={collapsed ? "right" : "bottom"}
			align={collapsed ? "start" : "center"}
			className="w-56 min-w-[var(--anchor-width)]"
		>
			{!authConfig.organizations.requireOrganization && (
				<>
					<DropdownMenuRadioGroup
						value={activeOrganization?.id ?? user.id}
						onValueChange={async (value: string) => {
							if (value === user.id) {
								await clearCache();
								await setActiveOrganization(null);
								router.replace("/");
							}
						}}
					>
						<DropdownMenuRadioItem
							value={user.id}
							className="gap-2 pl-3 flex cursor-pointer items-center justify-center"
						>
							<div className="gap-2 flex flex-1 items-center justify-start">
								<PersonalAccountIcon />
								{t("organizations.organizationSelect.personalAccount")}
							</div>
						</DropdownMenuRadioItem>
					</DropdownMenuRadioGroup>
					<DropdownMenuSeparator />
				</>
			)}
			<DropdownMenuRadioGroup
				value={activeOrganization?.slug}
				onValueChange={async (organizationSlug: string) => {
					await clearCache();
					await setActiveOrganization(organizationSlug);
					router.replace(`/${organizationSlug}`);
				}}
			>
				<DropdownMenuLabel className="text-xs text-foreground/60">
					{t("organizations.organizationSelect.organizations")}
				</DropdownMenuLabel>
				{listOrganizations?.map((organization) => (
					<DropdownMenuRadioItem
						key={organization.slug}
						value={organization.slug}
						className="gap-2 pl-3 flex cursor-pointer items-center justify-center"
					>
						<div className="gap-2 flex flex-1 items-center justify-start">
							<OrganizationLogo
								className="size-8"
								name={organization.name}
								logoUrl={organization.logo}
							/>
							{organization.name}
						</div>
					</DropdownMenuRadioItem>
				))}
			</DropdownMenuRadioGroup>

			{authConfig.organizations.enableUsersToCreateOrganizations && (
				<DropdownMenuGroup>
					<DropdownMenuItem
						nativeButton={false}
						className="text-sm cursor-pointer text-primary!"
						render={(props) => (
							<Link
								{...props}
								href="/new-organization"
								className={cn(props.className, "flex items-center")}
							>
								<PlusIcon className="mr-2 size-6 p-1 rounded-md bg-primary/20" />
								{t("organizations.organizationSelect.createNewOrganization")}
							</Link>
						)}
					/>
				</DropdownMenuGroup>
			)}
		</DropdownMenuContent>
	);

	const content = (
		<DropdownMenu>
			{triggerContent}
			{dropdownContent}
		</DropdownMenu>
	);

	if (collapsed) {
		return (
			<div className={className}>
				<TooltipProvider delay={0}>{content}</TooltipProvider>
			</div>
		);
	}

	return <div className={className}>{content}</div>;
}
