"use client";

import { useSession } from "@auth/hooks/use-session";
import { config } from "@config";
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

import { useIsMobile } from "../hooks/use-media-query";
import { ColorModeToggle } from "./ColorModeToggle";

export function UserMenu({ showUserName }: { showUserName?: boolean }) {
	const t = useTranslations();
	const { user } = useSession();
	const isMobile = useIsMobile();
	const marketingUrl = config.marketingUrl;

	const onLogout = async () => {
		await authClient.signOut({
			fetchOptions: {
				onSuccess: async () => {
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
		<DropdownMenu modal={false}>
			<DropdownMenuTrigger
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
						<span className="gap-2 flex items-center">
							<UserAvatar name={name ?? ""} avatarUrl={image} />
							{showUserName && (
								<span className="leading-tight text-left">
									<span className="font-medium text-sm">{name}</span>
									<span className="text-xs block opacity-70">{email}</span>
								</span>
							)}
						</span>

						{showUserName && <MoreVerticalIcon className="size-4" />}
					</button>
				)}
			/>

			<DropdownMenuContent
				side={dropdownSide}
				align={dropdownAlign}
				className="w-56 min-w-[var(--anchor-width)]"
			>
				<DropdownMenuGroup>
					<DropdownMenuLabel>
						{name}
						<span className="font-normal text-xs block opacity-70">{email}</span>
					</DropdownMenuLabel>
				</DropdownMenuGroup>

				<DropdownMenuSeparator />

				{/* Color mode selection */}
				<DropdownMenuItem
					className="gap-4 flex items-center justify-between hover:bg-transparent focus:bg-transparent"
					closeOnClick={false}
				>
					<span className="whitespace-nowrap">{t("app.userMenu.colorMode")}</span>
					<ColorModeToggle />
				</DropdownMenuItem>

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

				{config.docsUrl && (
					<DropdownMenuItem
						nativeButton={false}
						render={(props) => (
							<a
								{...props}
								href={config.docsUrl}
								className={cn(props.className, "flex items-center")}
							>
								<BookIcon className="mr-2 size-4" />
								{t("app.userMenu.documentation")}
							</a>
						)}
					/>
				)}

				{marketingUrl && (
					<DropdownMenuItem
						nativeButton={false}
						render={(props) => (
							<Link
								{...props}
								href={marketingUrl}
								className={cn(props.className, "flex items-center")}
							>
								<HomeIcon className="mr-2 size-4" />
								{t("app.userMenu.home")}
							</Link>
						)}
					/>
				)}

				<DropdownMenuItem onClick={onLogout}>
					<LogOutIcon className="mr-2 size-4" />
					{t("app.userMenu.logout")}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
