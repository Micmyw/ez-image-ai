"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, type ReactNode } from "react";

import { isVideoEffectPath } from "../../../video-effects/lib/paths";
import { videoEffectSignInHref } from "../../../video-effects/lib/sign-in";

type Props = { children: ReactNode; className?: string };

export function StudioSignInLink({ children, className }: Props) {
	const pathname = usePathname();
	const fallback = (
		<a className={className} href={videoEffectSignInHref(pathname)}>
			{children}
		</a>
	);
	if (!isVideoEffectPath(pathname)) return fallback;
	return (
		<Suspense fallback={fallback}>
			<EffectSignInLink className={className} pathname={pathname}>
				{children}
			</EffectSignInLink>
		</Suspense>
	);
}

function EffectSignInLink({ pathname, children, className }: Props & { pathname: string }) {
	const search = useSearchParams();
	// A document navigation reloads the root locale provider on account routes.
	return (
		<a className={className} href={videoEffectSignInHref(pathname, search)}>
			{children}
		</a>
	);
}
