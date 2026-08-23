const DEFAULT_PROVIDER_OUTPUT_HOSTS = [
	"replicate.delivery",
	"pbxt.replicate.delivery",
	"fal.media",
	"v3.fal.media",
] as const;

const DEFAULT_KIE_OUTPUT_HOSTS = ["tempfile.aiquickdraw.com"] as const;

export function providerCdnAllowlist(environment: NodeJS.ProcessEnv): string[] {
	const configured = environment.MEDIA_REMOTE_ALLOWED_HOSTS?.split(",")
		.map((host) => host.trim().toLowerCase())
		.filter(Boolean);
	const baseHosts = configured?.length ? configured : DEFAULT_PROVIDER_OUTPUT_HOSTS;
	const kieHosts = parseKieOutputHosts(environment.KIE_OUTPUT_HOSTS);

	return [...new Set([...baseHosts, ...DEFAULT_KIE_OUTPUT_HOSTS, ...kieHosts])];
}

function parseKieOutputHosts(value: string | undefined): string[] {
	if (!value) return [];

	return value.split(",").map((entry) => {
		const host = entry.trim().toLowerCase();
		if (!isExactDnsHostname(host)) {
			throw new Error("KIE_OUTPUT_HOSTS must contain exact DNS hostnames");
		}
		return host;
	});
}

function isExactDnsHostname(host: string): boolean {
	return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$/u.test(
		host,
	);
}
