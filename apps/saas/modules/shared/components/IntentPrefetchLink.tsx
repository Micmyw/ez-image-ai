"use client";

import Link from "next/link";
import { type ReactNode, useState } from "react";

export function IntentPrefetchLink({
	href,
	className,
	children,
}: {
	href: string;
	className?: string;
	children: ReactNode;
}) {
	const [prefetch, setPrefetch] = useState(false);
	const prefetchOnIntent = () => setPrefetch(true);

	return (
		<Link
			href={href}
			className={className}
			prefetch={prefetch ? null : false}
			onMouseEnter={prefetchOnIntent}
			onFocus={prefetchOnIntent}
			onPointerDown={prefetchOnIntent}
		>
			{children}
		</Link>
	);
}
