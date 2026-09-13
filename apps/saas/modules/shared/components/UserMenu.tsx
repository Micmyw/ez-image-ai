"use client";

import { useSession } from "@auth/hooks/use-session";
import { config } from "@config";
import { WORKSPACE_DRAFT_KEY } from "@media/lib/workspace-draft";
import { authClient } from "@repo/auth/client";
import {
	cn,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@repo/ui";
import { UserAvatar } from "@shared/components/UserAvatar";
import { BookIcon, HomeIcon, LogOutIcon, MoreVerticalIcon, SettingsIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { type MouseEvent, useRef, useState } from "react";

import { useIsMobile } from "../hooks/use-media-query";
import { ColorModeToggle } from "./ColorModeToggle";
import { studioPanelForPath, useStudio } from "./studio/studio-context";

export function UserMenu({
	showUserName,
	studio = false,
}: {
	showUserName?: boolean;
	studio?: boolean;
}) {
	const t = useTranslations();
	const { user } = useSession();
	const isMobile = useIsMobile();
	const workspace = useStudio();
	const [menuOpen, setMenuOpen] = useState(false);
	const panelTransition = useRef(false);
	const trigger = useRef<HTMLButtonElement>(null);
	function openWorkspacePanel(event: MouseEvent<HTMLDivElement>) {
		if (
			!studio ||
			!workspace ||
			event.button !== 0 ||
			event.metaKey ||
			event.ctrlKey ||
			event.shiftKey ||
			event.altKey
		)
			return;
		if (window.location.pathname !== "/" && window.location.pathname !== "/create") return;
		const anchor = (event.target as Element).closest("a");
		if (!anchor || anchor.target) return;
		const destination = new URL(anchor.href, window.location.href);
		if (destination.origin !== window.location.origin) return;
		const next = studioPanelForPath(destination.pathname);
		if (!next) return;
		event.preventDefault();
		panelTransition.current = true;
		setMenuOpen(false);
		requestAnimationFrame(() => {
			trigger.current?.focus({ preventScroll: true });
			workspace.openPanel(next);
		});
	}

	const onLogout = async () => {
		await authClient.signOut({
			fetchOptions: {
				onSuccess: async () => {
					try {
						window.sessionStorage.removeItem(WORKSPACE_DRAFT_KEY);
					} catch {
						/* Storage may be disabled. */
					}
					window.location.href = new URL(
						config.redirectAfterLogout,
						window.location.origin,
					).toString();
				},
			},
		});
	};

	if (!user) {
		return null;
	}

	const { name, email, image } = user;
	const dropdownSide = isMobile ? "bottom" : showUserName ? "top" : "right";
	const dropdownAlign = isMobile || !showUserName ? "end" : "start";

	return (
		<DropdownMenu
			modal={false}
			open={menuOpen}
			onOpenChange={(open) => {
				setMenuOpen(open);
				if (open) panelTransition.current = false;
			}}
		>
			<DropdownMenuTrigger
				ref={trigger}
				render={(props) => (
					<button
						{...props}
						type="button"
						className={cn(
							props.className,
							"gap-2 md:w-[100%+1rem] md:px-2 md:py-1.5 md:hover:bg-primary/5 flex w-full cursor-pointer items-center justify-between rounded-lg outline-hidden focus-visible:ring-2 focus-visible:ring-primary",
						)}
						aria-label="User menu"
					>
						<span className="gap-2 min-w-0 flex items-center">
							<UserAvatar name={name ?? ""} avatarUrl={image} />
							{showUserName && (
								<span className="min-w-0 max-w-28 leading-tight text-left">
									<span className="font-medium text-sm block truncate">{name}</span>
									<span className="text-xs block truncate opacity-70">{email}</span>
								</span>
							)}
						</span>

						{showUserName && <MoreVerticalIcon className="size-4 shrink-0" />}
					</button>
				)}
			/>

			<DropdownMenuContent
				positionMethod={studio ? "fixed" : undefined}
				data-studio-menu={studio ? "" : undefined}
				onClickCapture={openWorkspacePanel}
				finalFocus={() => !panelTransition.current}
				side={dropdownSide}
				align={dropdownAlign}
				className={cn("w-56 min-w-[var(--anchor-width)]", studio && "studio-theme")}
			>
				<DropdownMenuGroup>
					<DropdownMenuLabel className="break-words">
						{name}
						<span className="font-normal text-xs block opacity-70">{email}</span>
					</DropdownMenuLabel>
				</DropdownMenuGroup>

				<DropdownMenuSeparator />

				{studio && (
					<>
						<DropdownMenuItem
							nativeButton={false}
							render={(props) => (
								<Link {...props} href="/settings/billing">
									{t("settings.billing.title")}
								</Link>
							)}
						/>
						<DropdownMenuItem
							nativeButton={false}
							render={(props) => (
								<Link {...props} href="/history">
									{t("media.history.title")}
								</Link>
							)}
						/>
					</>
				)}

				{/* The studio follows the homepage palette; other pages retain theme selection. */}
				{!studio && (
					<>
						<DropdownMenuItem
							className="gap-4 flex items-center justify-between hover:bg-transparent focus:bg-transparent"
							closeOnClick={false}
						>
							<span className="whitespace-nowrap">{t("app.userMenu.colorMode")}</span>
							<ColorModeToggle />
						</DropdownMenuItem>
					</>
				)}

				<DropdownMenuSeparator />

				<DropdownMenuItem
					nativeButton={false}
					render={(props) => (
						<Link
							{...props}
							href="/settings/general"
							className={cn(props.className, "flex items-center")}
						>
							<SettingsIcon className="mr-2 size-4" />
							{t("app.userMenu.accountSettings")}
						</Link>
					)}
				/>

				<DropdownMenuItem
					nativeButton={false}
					render={(props) => (
						<Link {...props} href="/docs" className={cn(props.className, "flex items-center")}>
							<BookIcon className="mr-2 size-4" />
							{t("app.userMenu.documentation")}
						</Link>
					)}
				/>

				<DropdownMenuItem
					nativeButton={false}
					render={(props) => (
						<Link {...props} href="/" className={cn(props.className, "flex items-center")}>
							<HomeIcon className="mr-2 size-4" />
							{t("app.userMenu.home")}
						</Link>
					)}
				/>

				<DropdownMenuItem onClick={onLogout}>
					<LogOutIcon className="mr-2 size-4" />
					{t("app.userMenu.logout")}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
