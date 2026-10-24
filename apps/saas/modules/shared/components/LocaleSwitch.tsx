"use client";

import { config as i18nConfig, type Locale } from "@repo/i18n";
import { Button } from "@repo/ui/components/button";
import { GlobeIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";

type MenuModule = typeof import("./LocaleSwitchMenu");
let pendingMenu: Promise<MenuModule> | undefined;

function loadMenu() {
	return (pendingMenu ??= import("./LocaleSwitchMenu").catch((error: unknown) => {
		pendingMenu = undefined;
		throw error;
	}));
}

export function LocaleSwitch({
	className,
	disabled = false,
}: {
	className?: string;
	disabled?: boolean;
}) {
	const t = useTranslations("pricing.upgrade");
	const currentLocale = useLocale();
	const triggerId = useId();
	const requestVersion = useRef(0);
	const [loading, setLoading] = useState(false);
	const [menu, setMenu] = useState<{
		Component: MenuModule["LocaleSwitchMenu"];
		initialFocus?: "first" | "last";
	} | null>(null);
	useEffect(() => {
		if (disabled) {
			requestVersion.current++;
			setLoading(false);
		}
	}, [disabled]);
	useEffect(
		() => () => {
			requestVersion.current++;
		},
		[],
	);

	if (Object.keys(i18nConfig.locales).length <= 1) return null;
	if (menu) {
		return (
			<menu.Component
				className={className}
				disabled={disabled}
				triggerId={triggerId}
				initialFocus={menu.initialFocus}
			/>
		);
	}
	const preload = () => {
		// Warm code only: mounting here would replace a focused trigger before activation.
		if (!disabled) void loadMenu().catch(() => {});
	};
	const cancelOpening = () => {
		requestVersion.current++;
		setLoading(false);
	};
	const open = (initialFocus?: "first" | "last") => {
		if (disabled) return;
		if (loading) {
			cancelOpening();
			return;
		}
		const version = ++requestVersion.current;
		setLoading(true);
		void loadMenu().then(
			({ LocaleSwitchMenu }) => {
				if (requestVersion.current === version)
					setMenu({ Component: LocaleSwitchMenu, initialFocus });
			},
			() => {
				if (requestVersion.current === version) setLoading(false);
			},
		);
	};

	return (
		<Button
			id={triggerId}
			type="button"
			variant="ghost"
			size="icon"
			aria-label={t("language")}
			title={i18nConfig.locales[currentLocale as Locale]?.label}
			className={className}
			disabled={disabled}
			aria-haspopup="menu"
			aria-expanded={loading}
			aria-busy={loading}
			onPointerEnter={preload}
			onFocus={preload}
			onBlur={cancelOpening}
			onClick={(event) => open(event.detail === 0 ? "first" : undefined)}
			onKeyDown={(event) => {
				if (event.key === "Escape" && loading) {
					event.preventDefault();
					cancelOpening();
				} else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
					event.preventDefault();
					open(event.key === "ArrowUp" ? "last" : "first");
				}
			}}
		>
			<GlobeIcon className="size-4" aria-hidden />
		</Button>
	);
}
