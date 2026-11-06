/** URL replacement changes only authorization boundaries, never prompt or reference ordering. */
export function replaceSourceTemplateUrls(
	value: unknown,
	replacements: ReadonlyMap<string, string>,
): unknown {
	if (typeof value === "string") return replacements.get(value) ?? value;
	if (Array.isArray(value))
		return value.map((item) => replaceSourceTemplateUrls(item, replacements));
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				replaceSourceTemplateUrls(item, replacements),
			]),
		);
	return value;
}
