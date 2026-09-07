import { cn } from "../lib";

export function Logo({
	withLabel = true,
	className,
	label = "EzPic",
	decorative = false,
}: {
	className?: string;
	withLabel?: boolean;
	label?: string;
	decorative?: boolean;
}) {
	return (
		<span className={cn("font-semibold flex items-center leading-none text-foreground", className)}>
			<svg
				className="size-8 text-primary"
				viewBox="0 0 32 32"
				aria-hidden={decorative || undefined}
			>
				{!decorative && <title>{`${label} image editor mark`}</title>}
				<path d="M4 16V9a5 5 0 0 1 5-5h11v4H9.5A1.5 1.5 0 0 0 8 9.5V16H4Z" fill="currentColor" />
				<path
					d="M28 16v7a5 5 0 0 1-5 5H12v-4h10.5a1.5 1.5 0 0 0 1.5-1.5V16h4Z"
					fill="currentColor"
				/>
				<path d="m4 18.75 4-4V19H4Z" fill="currentColor" opacity="0.55" />
				<path d="m28 13.25-4 4V13h4Z" fill="currentColor" opacity="0.55" />
				<path
					d="M24.75 2.75c.4 2.35 1.65 3.6 4 4-2.35.4-3.6 1.65-4 4-.4-2.35-1.65-3.6-4-4 2.35-.4 3.6-1.65 4-4Z"
					fill="#fdba74"
				/>
			</svg>
			{withLabel && <span className="ml-3 text-lg md:block hidden">{label}</span>}
		</span>
	);
}
