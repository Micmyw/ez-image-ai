"use client";

import { cn } from "@repo/ui";
import { Tabs, TabsList, TabsTrigger } from "@repo/ui/components/tabs";
import { useTranslations } from "next-intl";

export function LoginModeSwitch({
	activeMode,
	onChange,
	className,
	variant = "default",
}: {
	activeMode: "password" | "magic-link";
	onChange: (mode: string) => void;
	className?: string;
	variant?: "default" | "auth";
}) {
	const t = useTranslations();
	return (
		<Tabs value={activeMode} onValueChange={onChange} className={className}>
			<TabsList
				className={cn(
					"w-full",
					variant === "auth" && "bg-black/20 p-1 rounded-xl border-0 text-[#b7acbf]",
				)}
			>
				<TabsTrigger
					value="password"
					className={cn(
						"flex-1",
						variant === "auth" &&
							"mb-0 min-h-10 px-4 hover:text-white aria-selected:bg-white/[0.09] aria-selected:text-white rounded-lg border-0 text-[#a99db2] aria-selected:border-transparent",
					)}
				>
					{t("auth.login.modes.password")}
				</TabsTrigger>
				<TabsTrigger
					value="magic-link"
					className={cn(
						"flex-1",
						variant === "auth" &&
							"mb-0 min-h-10 px-4 hover:text-white aria-selected:bg-white/[0.09] aria-selected:text-white rounded-lg border-0 text-[#a99db2] aria-selected:border-transparent",
					)}
				>
					{t("auth.login.modes.magicLink")}
				</TabsTrigger>
			</TabsList>
		</Tabs>
	);
}
