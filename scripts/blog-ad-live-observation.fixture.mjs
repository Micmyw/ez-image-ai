import { createHash } from "node:crypto";

// OFFLINE OBSERVER EXECUTION-PATH MOCK ONLY.
// Every request is fulfilled from these self-authored strings or aborted. This
// module does not exercise Next source, deployed headers, real vendor code,
// real creative behavior, or the browser Response-stage pause safety boundary.
// A successful observer run using this module must retain that evidence limit.
// Protected-route requests are aborted: offline mode must explicitly visit
// /login and record the outcome as simulated, never as a real HTTP auth redirect.
const LOCAL_APP_ORIGIN = "http://127.0.0.1:3018";
const AD_ORIGIN = "https://ads.ezimageai.com";
const ARTICLE_PATH = "/blog/tesco-ai-meal-planning-assistant";
const NATIVE_CONTAINER_ID = "container-0a9986f36ff843c117e0f20e732a1e08";
const EXPECTED_LOADERS = {
	banner: "https://www.highrevenueformat.com/2266a6811e407f9b362831f885d09d1e/invoke.js",
	native:
		"https://pl31768149.profitableratecpmnetwork.com/0a9986f36ff843c117e0f20e732a1e08/invoke.js",
};
const PROTECTED_PATHS = new Set(["/dashboard", "/settings/billing", "/checkout-return"]);
const FIXTURE_MARKER = "OFFLINE OBSERVER EXECUTION-PATH FIXTURE — NO REAL ADVERTISEMENT";

function inlineHash(source) {
	return `'sha256-${createHash("sha256").update(source).digest("base64")}'`;
}

function documentHeaders({ script = "'none'", style = "'none'", frames, ancestors = "'none'" }) {
	return {
		"Content-Security-Policy": [
			"default-src 'none'",
			"base-uri 'none'",
			"form-action 'none'",
			`frame-ancestors ${ancestors}`,
			"object-src 'none'",
			`script-src ${script}`,
			`style-src ${style}`,
			`frame-src ${frames}`,
			"connect-src 'none'",
			"img-src data:",
			"font-src 'none'",
			"worker-src 'none'",
		].join("; "),
		"Referrer-Policy": "no-referrer",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
		"X-Robots-Tag": "noindex, nofollow",
		"X-Offline-Observer-Fixture": "execution-path-mock-only",
	};
}

const parentStyle = `html,body{margin:0;min-width:0;max-width:100%;overflow-x:hidden}*{box-sizing:border-box}body{padding:24px;font:16px system-ui}main{max-width:1040px;margin:auto}button{min-height:44px;padding:8px 16px}[data-blog-ad]{width:100%;min-width:0;max-width:100%;margin-block:16px;overflow:hidden}[data-blog-ad-frame]{display:block;border:0;max-width:100%}@media(max-width:767px){[data-blog-ad="banner"]{display:none}}`;
const childStyle = `html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden}*{box-sizing:border-box}.offline-observer-card{width:100%;max-width:100%;padding:12px;font:14px system-ui;overflow-wrap:anywhere}`;

function plainDocument() {
	return {
		body: `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>Offline observer route fixture</title><style>${parentStyle}</style></head><body><main data-offline-observer-fixture="product"><h1>Offline observer route fixture</h1><p>${FIXTURE_MARKER}</p><a href="/blog">Blog fixture route</a></main></body></html>`,
		headers: documentHeaders({
			style: inlineHash(parentStyle),
			frames: "https://challenges.cloudflare.com",
		}),
	};
}

function articleDocument(format, adOrigin) {
	const script = `(() => {
		const format = ${JSON.stringify(format)};
		const source = ${JSON.stringify(`${adOrigin}/${format}.html`)};
		const slot = document.querySelector('[data-blog-ad="' + format + '"]');
		const button = document.querySelector('[data-offline-show-control]');
		let requested = false;
		const removeFrames = () => {
			for (const frame of slot.querySelectorAll("iframe")) {
				frame.removeAttribute("srcdoc");
				frame.src = "about:blank";
				frame.remove();
			}
		};
		const reset = () => {
			removeFrames();
			requested = false;
			button.textContent = "Show blog ads";
			button.setAttribute("aria-pressed", "false");
		};
		const synchronize = () => {
			const fits = format === "native" || (getComputedStyle(slot).display !== "none" && slot.getBoundingClientRect().width >= 728);
			if (!requested || !fits) { removeFrames(); return; }
			if (slot.querySelector("iframe")) return;
			const frame = document.createElement("iframe");
			if (!("credentialless" in frame)) { reset(); return; }
			frame.credentialless = true;
			frame.dataset.blogAdFrame = format;
			frame.title = "Offline " + format + " execution-path fixture";
			frame.setAttribute("sandbox", "allow-scripts");
			frame.referrerPolicy = "no-referrer";
			frame.width = format === "banner" ? "728" : "100%";
			frame.height = format === "banner" ? "90" : "320";
			frame.src = source;
			slot.appendChild(frame);
		};
		button.addEventListener("click", () => {
			if (requested) { reset(); return; }
			requested = true;
			button.textContent = "Hide blog ads";
			button.setAttribute("aria-pressed", "true");
			synchronize();
		});
		new ResizeObserver(synchronize).observe(slot);
		window.addEventListener("pagehide", reset);
		window.addEventListener("pageshow", reset);
	})();`;
	return {
		body: `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>Offline observer article fixture</title><style>${parentStyle}</style></head><body><main data-offline-observer-fixture="article"><h1>Offline observer article fixture</h1><p>${FIXTURE_MARKER}</p><nav class="blog-breadcrumb"><a href="/">Home fixture route</a><a href="/blog">Blog fixture route</a></nav><section data-blog-ads aria-label="Offline advertising fixture"><p>Advertisement fixture — no live inventory</p><button type="button" data-offline-show-control aria-pressed="false">Show blog ads</button><div data-blog-ad="${format}"></div></section></main><script>${script}</script></body></html>`,
		headers: documentHeaders({
			script: inlineHash(script),
			style: inlineHash(parentStyle),
			frames: `https://challenges.cloudflare.com ${adOrigin}`,
		}),
	};
}

function adDocument(format, appOrigin, loader) {
	const container = format === "native" ? `<div id="${NATIVE_CONTAINER_ID}"></div>` : "";
	return {
		body: `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><style>${childStyle}</style></head><body data-offline-observer-fixture="ad-document">${container}<script referrerpolicy="no-referrer" src="${loader}"></script></body></html>`,
		headers: documentHeaders({
			script: new URL(loader).origin,
			style: inlineHash(childStyle),
			frames: "'none'",
			ancestors: appOrigin,
		}),
	};
}

function harmlessLoader(format) {
	return `(() => {
		const card = document.createElement("div");
		card.className = "offline-observer-card";
		card.dataset.offlineObserverFixture = ${JSON.stringify(format)};
		card.textContent = ${JSON.stringify(`${FIXTURE_MARKER}. ${format} local placeholder; no vendor code, images, click target or creative rotation.`)};
		const container = ${format === "native" ? `document.getElementById(${JSON.stringify(NATIVE_CONTAINER_ID)})` : "document.body"};
		container.appendChild(card);
	})();`;
}

/**
 * Fulfill only the local observer's mock path, never release a request to network.
 * @returns {Promise<{classification: string, url: string}>} Explicit fixture provenance.
 */
export async function fulfillOfflineFixture(route, { format, appOrigin, adOrigin, loaders } = {}) {
	const request = route.request();
	const url = request.url();
	const abort = async (classification) => {
		await route.abort("blockedbyclient");
		return { classification, url };
	};
	if (
		appOrigin !== LOCAL_APP_ORIGIN ||
		adOrigin !== AD_ORIGIN ||
		!["banner", "native"].includes(format) ||
		loaders?.banner !== EXPECTED_LOADERS.banner ||
		loaders?.native !== EXPECTED_LOADERS.native
	)
		return abort("offline-observer-fixture-invalid-configuration-aborted");
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return abort("offline-observer-fixture-invalid-url-aborted");
	}
	if (parsed.username || parsed.password || !["GET", "HEAD"].includes(request.method()))
		return abort("offline-observer-fixture-method-or-credentials-aborted");
	const fulfill = async (classification, document) => {
		await route.fulfill({
			status: 200,
			contentType: "text/html; charset=utf-8",
			headers: document.headers,
			body: request.method() === "HEAD" ? "" : document.body,
		});
		return { classification, url };
	};
	if (parsed.origin === appOrigin && request.isNavigationRequest()) {
		let mainDocument;
		try {
			mainDocument = request.frame().parentFrame() === null;
		} catch {
			return abort("offline-observer-fixture-unowned-app-frame-aborted");
		}
		if (!mainDocument) return abort("offline-observer-fixture-app-child-document-aborted");
		if (PROTECTED_PATHS.has(parsed.pathname)) {
			return abort("offline-observer-fixture-protected-route-requires-simulated-login-aborted");
		}
		if (parsed.pathname === ARTICLE_PATH && parsed.search === `?blogAdTest=${format}`)
			return fulfill(
				"offline-observer-fixture-preview-document",
				articleDocument(format, adOrigin),
			);
		return fulfill("offline-observer-fixture-product-document", plainDocument());
	}
	if (url === `${adOrigin}/${format}.html` && request.isNavigationRequest())
		return fulfill(
			"offline-observer-fixture-ad-document",
			adDocument(format, appOrigin, loaders[format]),
		);
	if (url === loaders[format] && request.resourceType() === "script") {
		await route.fulfill({
			status: 200,
			contentType: "application/javascript; charset=utf-8",
			headers: {
				"Referrer-Policy": "no-referrer",
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
				"X-Offline-Observer-Fixture": "harmless-local-loader-only",
			},
			body: request.method() === "HEAD" ? "" : harmlessLoader(format),
		});
		return { classification: "offline-observer-fixture-harmless-loader", url };
	}
	return abort("offline-observer-fixture-unapproved-request-aborted");
}
