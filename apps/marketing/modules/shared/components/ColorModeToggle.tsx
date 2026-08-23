"use client";

import { cn } from "@repo/ui";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@repo/ui/components/tooltip";
import { MoonIcon, SunIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

const DEFAULT_THEME = "light";

export function ColorModeToggle() {
	const { resolvedTheme, setTheme, theme } = useTheme();
	const [mounted, setMounted] = useState(false);
	const [value, setValue] = useState<string>(DEFAULT_THEME);
	const t = useTranslations();

	const colorModeOptions = [
		{ value: "light", icon: SunIcon },
		{ value: "dark", icon: MoonIcon },
	] as const;

	useEffect(() => {
		setMounted(true);
	}, []);

	useEffect(() => {
		if (!mounted) {
			return;
		}
		const resolved = theme === "system" ? resolvedTheme : theme;
		if (resolved) {
			setValue(resolved);
		}
	}, [theme, resolvedTheme, mounted]);

	const displayValue = mounted ? value : DEFAULT_THEME;
	const activeIndex = colorModeOptions.findIndex((option) => option.value === displayValue);

	const handleClick = (optionValue: string) => {
		setTheme(optionValue);
		setValue(optionValue);
	};

	return (
		<TooltipProvider delay={0}>
			<div
				className="gap-0 p-0.5 relative inline-flex items-center rounded-full bg-muted"
				data-test="color-mode-toggle"
			>
				{/* Active indicator */}
				<div
					className="left-0.5 top-0.5 h-7 w-7 shadow-sm ease-in-out absolute rounded-full border border-border bg-background transition-transform duration-200"
					style={{
						transform: `translateX(${activeIndex * 100}%)`,
					}}
					aria-hidden="true"
				/>

				{/* Icons */}
				{colorModeOptions.map((option) => {
					const Icon = option.icon;
					const isActive = option.value === displayValue;
					const label = t(`common.colorMode.${option.value}`);

					return (
						<Tooltip key={option.value}>
							<TooltipTrigger
								render={(props) => (
									<button
										{...props}
										type="button"
										onClick={(e) => {
											props.onClick?.(e);
											handleClick(option.value);
										}}
										className={cn(
											props.className,
											"h-7 w-7 relative z-10 flex items-center justify-center rounded-full transition-colors",
											"focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none",
											isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground",
										)}
										data-test={`color-mode-toggle-item-${option.value}`}
										aria-label={`${label} mode`}
										aria-pressed={isActive}
									>
										<Icon className="size-3.5" />
									</button>
								)}
							/>
							<TooltipContent>{label}</TooltipContent>
						</Tooltip>
					);
				})}
			</div>
		</TooltipProvider>
	);
}
