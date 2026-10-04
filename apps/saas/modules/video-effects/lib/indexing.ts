/** Publication is independent from temporary runtime availability; private views stay noindex. */
export function videoEffectMayIndex(
	published: boolean,
	search: { job?: string | string[]; lang?: string | string[] },
) {
	return (
		published && search.job === undefined && (search.lang === undefined || search.lang === "en")
	);
}
