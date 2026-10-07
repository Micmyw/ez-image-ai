export type GeneratorMode = "image" | "video";

export function generatorMode(params: Pick<URLSearchParams, "get">): GeneratorMode {
	return params.get("mode") === "video" ? "video" : "image";
}

/** Keep the image job/model and video job in separate URL fields. */
export function generatorModeUrl(href: string, mode: GeneratorMode): string {
	const url = new URL(href, "https://local.invalid");
	if (mode === "video") url.searchParams.set("mode", "video");
	else url.searchParams.delete("mode");
	return `${url.pathname}${url.search}${url.hash}`;
}

export function videoJobUrl(href: string, jobId: string): string {
	const url = new URL(href, "https://local.invalid");
	url.searchParams.set("videoJob", jobId);
	return `${url.pathname}${url.search}${url.hash}`;
}

export function validVideoJobId(value: string | null | undefined): string | null {
	return value && /^[a-zA-Z0-9_-]{1,120}$/.test(value) ? value : null;
}
