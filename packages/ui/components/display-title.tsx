import type { ComponentPropsWithoutRef } from "react";

import { cn } from "../lib";

import "./display-title.css";

export type DisplayTitleProps = Omit<ComponentPropsWithoutRef<"h1">, "children"> & {
	as?: "h1" | "h2" | "h3";
	label: string;
	lead: string;
	accent: string;
	edition?: string;
	descriptor?: string;
	variant?: "refract" | "alloy";
};

/** A selectable, accessible text wordmark. GlowSurface can supply its light position. */
export function DisplayTitle({
	as: Heading = "h1",
	label,
	lead,
	accent,
	edition,
	descriptor,
	variant = "refract",
	className,
	...props
}: DisplayTitleProps) {
	return (
		<Heading
			{...props}
			aria-label={label}
			className={cn("display-title", className)}
			data-display-title={variant}
		>
			<span className="display-title-lockup" aria-hidden="true">
				<span className="display-title-name">
					<span className="display-title-lead">{lead}</span>
					<span className="display-title-accent">{accent}</span>
				</span>{" "}
				{edition && (
					<span className="display-title-edition">
						<span>{edition}</span>
						{descriptor && <small>{descriptor}</small>}
					</span>
				)}
			</span>
		</Heading>
	);
}
