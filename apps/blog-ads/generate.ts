import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	getBlogAdDocument,
	type BlogAdFormat,
} from "../saas/modules/public-content/lib/blog-ads.ts";

export const MAX_TEST_WINDOW_MS = 2 * 60 * 60 * 1000;
const SOURCE_HOSTS: Record<BlogAdFormat, string> = {
	banner: "https://www.highrevenueformat.com",
	native: "https://pl31768149.profitableratecpmnetwork.com",
};
// Review fingerprints pin the exact approved units AND static style. Configuration
// still comes only from getBlogAdDocument; a template change requires explicit review.
const SOURCE_TEMPLATE_DIGESTS: Record<BlogAdFormat, string> = {
	banner: "849934b3b232c5bdd79a77fdd037735f377ba308de18c92d00ba7776a95473f5",
	native: "06c3b7d8c194a8b40fd76f5b729e3dc272242dcfe894dca3403ec303aaac93f6",
};
const DISABLED_FEATURES = [
	"accelerometer",
	"autoplay",
	"attribution-reporting",
	"bluetooth",
	"browsing-topics",
	"camera",
	"clipboard-read",
	"clipboard-write",
	"display-capture",
	"document-domain",
	"encrypted-media",
	"fullscreen",
	"geolocation",
	"gyroscope",
	"hid",
	"idle-detection",
	"join-ad-interest-group",
	"local-fonts",
	"magnetometer",
	"microphone",
	"midi",
	"otp-credentials",
	"payment",
	"picture-in-picture",
	"private-aggregation",
	"publickey-credentials-create",
	"publickey-credentials-get",
	"run-ad-auction",
	"screen-wake-lock",
	"serial",
	"speaker-selection",
	"storage-access",
	"sync-xhr",
	"usb",
	"web-share",
	"window-management",
	"xr-spatial-tracking",
] as const;

type SourceDocument = {
	style: string;
	config?: string;
	container: string;
	externalScript: string;
	host: string;
};
export type StaticAdAsset = { html: string; csp: string };
export type StaticAdBuild = {
	enabled: boolean;
	testUntil?: string;
	files: { "banner.html": string; "native.html": string; _headers: string };
};

export function parseTestUntil(value: string, now = Date.now()): number {
	if (!Number.isFinite(now)) {
		throw new Error("The current time must be finite.");
	}
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) {
		throw new Error("--test-until requires an explicit UTC YYYY-MM-DDTHH:mm:ssZ timestamp.");
	}
	const deadline = Date.parse(value);
	if (
		!Number.isFinite(deadline) ||
		new Date(deadline).toISOString() !== value.replace("Z", ".000Z")
	) {
		throw new Error("--test-until must be a real UTC calendar timestamp.");
	}
	if (deadline <= now || deadline - now > MAX_TEST_WINDOW_MS) {
		throw new Error("--test-until must be in the future and no more than two hours away.");
	}
	return deadline;
}

// Deliberately accept only the small, known shared template. A new tag, attribute,
// supplier host or capability must fail review rather than silently widening CSP.
export function readSourceDocument(format: BlogAdFormat, html: string): SourceDocument {
	if (createHash("sha256").update(html).digest("hex") !== SOURCE_TEMPLATE_DIGESTS[format]) {
		throw new Error(`Unreviewed ${format} shared document change.`);
	}
	const document = html.match(
		/^<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><style>([^<]*)<\/style><\/head><body>([\s\S]*)<\/body><\/html>$/,
	);
	if (!document) {
		throw new Error(`Unexpected ${format} shared document structure.`);
	}
	const [, style, body] = document;
	if (/(?:url\s*\(|@import|expression\s*\(|[<>])/i.test(style)) {
		throw new Error("External or active style content is not permitted.");
	}
	const host = SOURCE_HOSTS[format];
	if (format === "banner") {
		const parts = body.match(
			/^<script>([^<]*)<\/script>(<script referrerpolicy="no-referrer" src="([^"]+)"><\/script>)$/,
		);
		if (!parts) {
			throw new Error("Unexpected banner scripts or attributes.");
		}
		const [, config, externalScript, src] = parts;
		const options = config.match(
			/^atOptions = \{'key':'([a-f0-9]{32})','format':'iframe','height':90,'width':728,'params':\{\}\};$/,
		);
		if (!options || src !== `${host}/${options[1]}/invoke.js`) {
			throw new Error("Unexpected banner options, source host or unit path.");
		}
		return { style, config, container: "", externalScript, host };
	}
	const parts = body.match(
		/^(<script async="async" data-cfasync="false" referrerpolicy="no-referrer" src="([^"]+)"><\/script>)(<div id="container-([a-f0-9]{32})"><\/div>)$/,
	);
	if (!parts || parts[2] !== `${host}/${parts[4]}/invoke.js`) {
		throw new Error("Unexpected native script, container, source host or unit path.");
	}
	return { style, container: parts[3], externalScript: parts[1], host };
}

export function contentHash(content: string): string {
	return `'sha256-${createHash("sha256").update(content).digest("base64")}'`;
}

function policy(scripts: string[], style?: string, host?: string): string {
	const supplier = host ?? "'none'";
	return [
		"default-src 'none'",
		`script-src ${scripts.length ? `${scripts.map(contentHash).join(" ")} ${host}` : "'none'"}`,
		"script-src-attr 'none'",
		`style-src ${style ? contentHash(style) : "'none'"}`,
		"style-src-attr 'none'",
		`img-src ${supplier}`,
		`frame-src ${supplier}`,
		`connect-src ${supplier}`,
		"font-src 'none'",
		"media-src 'none'",
		"worker-src 'none'",
		"manifest-src 'none'",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
		"frame-ancestors https://ezimageai.com",
		"sandbox allow-scripts",
	].join("; ");
}

function createStaticAdAsset(format: BlogAdFormat, deadline?: number): StaticAdAsset {
	if (deadline === undefined) {
		return {
			html: '<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow"></head><body></body></html>\n',
			csp: policy([]),
		};
	}
	if (!Number.isFinite(deadline)) {
		throw new Error("The deadline must be finite.");
	}
	const source = readSourceDocument(format, getBlogAdDocument(format));
	const scripts: string[] = [];
	if (source.config) {
		scripts.push(`if(window.top!==window.self&&Date.now()<${deadline}){${source.config}}`);
	}
	// Parser insertion preserves the supplied banner's synchronous script behavior.
	// It is invoked only by this initial hashed script, before the finite deadline.
	// Only an embedded document starts inventory. Its own navigation at expiry
	// destroys the loaded document; the host also removes the iframe at expiry.
	// There is no parent DOM access, retry or alternate supplier.
	const scriptLiteral = JSON.stringify(source.externalScript).replace(/</g, "\\u003c");
	scripts.push(
		`(()=>{if(window.top===window.self){return;}const expire=()=>{window.location.replace("about:blank");};const delay=${deadline}-Date.now();if(delay<=0){expire();return;}setTimeout(expire,Math.min(delay,${MAX_TEST_WINDOW_MS}));if(Date.now()<${deadline}){document.write(${scriptLiteral});}})();`,
	);
	return {
		html: `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow"><style>${source.style}</style></head><body>${source.container}${scripts.map((script) => `<script>${script}</script>`).join("")}</body></html>\n`,
		csp: policy(scripts, source.style, source.host),
	};
}

function headersFor(path: string, asset: StaticAdAsset): string {
	return [
		path,
		`  Content-Security-Policy: ${asset.csp}`,
		"  Referrer-Policy: no-referrer",
		"  X-Content-Type-Options: nosniff",
		"  X-Robots-Tag: noindex, nofollow, noarchive",
		"  Cache-Control: no-store",
		`  Permissions-Policy: ${DISABLED_FEATURES.map((feature) => `${feature}=()`).join(", ")}`,
	].join("\n");
}

export function buildStaticAds(testUntil?: string, now = Date.now()): StaticAdBuild {
	const deadline = testUntil === undefined ? undefined : parseTestUntil(testUntil, now);
	const banner = createStaticAdAsset("banner", deadline);
	const native = createStaticAdAsset("native", deadline);
	const headers = `${headersFor("/banner.html", banner)}\n\n${headersFor("/native.html", native)}\n`;
	if (headers.split("\n").some((line) => line.length > 2000)) {
		throw new Error("A static header exceeds Cloudflare's 2,000-character line limit.");
	}
	return {
		enabled: deadline !== undefined,
		...(testUntil === undefined ? {} : { testUntil }),
		files: { "banner.html": banner.html, "native.html": native.html, _headers: headers },
	};
}

export function parseArguments(args: string[]): string | undefined {
	if (args.length === 0) {
		return undefined;
	}
	if (args.length === 2 && args[0] === "--test-until") {
		return args[1];
	}
	throw new Error("Usage: generate.ts [--test-until YYYY-MM-DDTHH:mm:ssZ]");
}

export async function writeStaticAds(build: StaticAdBuild, directory: string): Promise<void> {
	await mkdir(directory, { recursive: true });
	for (const [name, content] of Object.entries(build.files)) {
		await writeFile(resolve(directory, name), content, "utf8");
	}
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
	try {
		const build = buildStaticAds(parseArguments(process.argv.slice(2)));
		await writeStaticAds(build, resolve(dirname(currentFile), "dist"));
		console.log(
			build.enabled
				? `Generated two static ad documents for the finite test ending ${build.testUntil}.`
				: "Generated two blank static ad documents (default off).",
		);
	} catch (error) {
		console.error(error instanceof Error ? error.message : "Static ad generation failed.");
		process.exitCode = 1;
	}
}
