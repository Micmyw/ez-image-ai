import { isVideoEffectPath, RAINDANCE_PATH } from "./paths";

/** Login may restore an owned job, but must never forward asset URLs or arbitrary query state. */
export function videoEffectSignInHref(
	pathname: string,
	search: Pick<URLSearchParams, "getAll"> = new URLSearchParams(),
): string {
	if (!isVideoEffectPath(pathname)) return "/login";
	const query = new URLSearchParams();
	const jobs = search.getAll("job");
	if (jobs.length === 1 && /^[a-zA-Z0-9_-]{1,128}$/.test(jobs[0]!)) query.set("job", jobs[0]!);
	const modes = search.getAll("mode");
	if (
		pathname === RAINDANCE_PATH &&
		modes.length === 1 &&
		(modes[0] === "solo" || modes[0] === "duo")
	)
		query.set("mode", modes[0]);
	const returnPath = `${pathname}${query.size ? `?${query}` : ""}`;
	return `/login?redirectTo=${encodeURIComponent(returnPath)}`;
}
