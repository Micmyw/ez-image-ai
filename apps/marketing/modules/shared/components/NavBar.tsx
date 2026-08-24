"use client";

import { config } from "@config";
import { LocaleLink, useLocalePathname } from "@i18n/routing";
import { cn, Logo } from "@repo/ui";
import { Button } from "@repo/ui/components/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@repo/ui/components/sheet";
import { ColorModeToggle } from "@shared/components/ColorModeToggle";
import { MenuIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import NextLink from "next/link";
import { useEffect, useState } from "react";
import { useDebounceCallback } from "usehooks-ts";

export function NavBar() {
	const t = useTranslations();
	const localePathname = useLocalePathname();
	const saasUrl = config.saasUrl;
	const signInUrl = saasUrl ? new URL("/login", saasUrl).toString() : undefined;
	const startEditingUrl = saasUrl ? new URL("/signup", saasUrl).toString() : undefined;

	const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
	const [isTop, setIsTop] = useState(true);

	const handleMobileMenuClose = () => {
		setMobileMenuOpen(false);
	};

	const debouncedScrollHandler = useDebounceCallback(
		() => {
			setIsTop(window.scrollY <= 10);
		},
		150,
		{
			maxWait: 150,
		},
	);

	useEffect(() => {
		window.addEventListener("scroll", debouncedScrollHandler);
		debouncedScrollHandler();
		return () => {
			window.removeEventListener("scroll", debouncedScrollHandler);
		};
	}, [debouncedScrollHandler]);

	useEffect(() => {
		handleMobileMenuClose();
	}, [localePathname]);

	const menuItems: {
		label: string;
		href: string;
	}[] = [
		{
			label: t("common.menu.examples"),
			href: "/#examples",
		},
		{
			label: t("common.menu.howItWorks"),
			href: "/#how-it-works",
		},
		{
			label: t("common.menu.pricing"),
			href: "/#pricing",
		},
		{
			label: t("common.menu.faq"),
			href: "/#faq",
		},
	];

	const isMenuItemActive = (href: string) => localePathname.startsWith(href);

	return (
		<nav
			className={cn("top-0 sticky z-50 w-full bg-background transition-shadow duration-200", {
				"border-b": !isTop,
			})}
			data-test="navigation"
		>
			<div className="container">
				<div
					className={cn(
						"gap-6 flex items-center justify-stretch transition-[padding] duration-200",
						!isTop ? "py-4" : "py-6",
					)}
				>
					<div className="flex flex-1 justify-start">
						<LocaleLink href="/" className="block hover:no-underline active:no-underline">
							<Logo label={config.appName} />
						</LocaleLink>
					</div>

					<div className="lg:flex hidden flex-1 items-center justify-center">
						{menuItems.map((menuItem) => (
							<LocaleLink
								key={menuItem.href}
								href={menuItem.href}
								className={cn(
									"px-3 py-2 font-medium text-sm block shrink-0 text-foreground/80",
									isMenuItemActive(menuItem.href) ? "font-bold text-foreground" : "",
								)}
								prefetch
							>
								{menuItem.label}
							</LocaleLink>
						))}
					</div>

					<div className="gap-3 flex flex-1 items-center justify-end">
						<ColorModeToggle />

						<Sheet open={mobileMenuOpen} onOpenChange={(open) => setMobileMenuOpen(open)}>
							<SheetTrigger
								render={
									<Button
										className="lg:hidden"
										size="icon"
										variant="secondary"
										aria-label={t("common.aria.menu")}
									>
										<MenuIcon className="size-4" />
									</Button>
								}
							/>
							<SheetContent className="w-[280px]" side="right">
								<SheetTitle />
								<div className="flex flex-col items-start justify-center">
									{menuItems.map((menuItem) => (
										<LocaleLink
											key={menuItem.href}
											href={menuItem.href}
											onClick={handleMobileMenuClose}
											className={cn(
												"px-3 py-2 font-medium text-base block shrink-0 text-foreground/80",
												isMenuItemActive(menuItem.href) ? "font-bold text-foreground" : "",
											)}
											prefetch
										>
											{menuItem.label}
										</LocaleLink>
									))}

									{signInUrl && (
										<NextLink
											href={signInUrl}
											className="px-3 py-2 text-base block"
											onClick={handleMobileMenuClose}
											prefetch
										>
											{t("common.menu.login")}
										</NextLink>
									)}
									{startEditingUrl && (
										<NextLink
											href={startEditingUrl}
											className="px-3 py-2 font-medium text-base block"
											onClick={handleMobileMenuClose}
											prefetch
										>
											{t("common.menu.startEditing")}
										</NextLink>
									)}
								</div>
							</SheetContent>
						</Sheet>

						{signInUrl && (
							<Button
								className="lg:flex hidden"
								variant="secondary"
								render={(props) => (
									<NextLink {...props} href={signInUrl} prefetch>
										{t("common.menu.login")}
									</NextLink>
								)}
							/>
						)}
						{startEditingUrl && (
							<Button
								className="lg:flex hidden"
								variant="primary"
								render={(props) => (
									<NextLink {...props} href={startEditingUrl} prefetch>
										{t("common.menu.startEditing")}
									</NextLink>
								)}
							/>
						)}
					</div>
				</div>
			</div>
		</nav>
	);
}
