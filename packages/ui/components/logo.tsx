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
				<rect x="3" y="3" width="26" height="26" rx="8" fill="currentColor" opacity="0.14" />
				<path
					d="m8.5 22 5.25-5.5 4.1 4.1 2.65-2.65 3 3"
					fill="none"
					stroke="currentColor"
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth="2.25"
				/>
				<circle cx="11" cy="11" r="2" fill="currentColor" />
				<path
					d="M22 7v6M19 10h6"
					fill="none"
					stroke="currentColor"
					strokeLinecap="round"
					strokeWidth="2"
				/>
			</svg>
			{withLabel && <span className="ml-3 text-lg md:block hidden">{label}</span>}
		</span>
	);
}
