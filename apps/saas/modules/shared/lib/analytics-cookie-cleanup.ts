/** Remove only the known optional vendor cookies, including parent-domain variants. */
export function clearVendorAnalyticsCookies(browser: Window) {
	const names = browser.document.cookie
		.split(";")
		.map((part) => part.trim().split("=")[0]!)
		.filter((name) => /^_ga(?:_|$)/.test(name) || ["_clck", "_clsk"].includes(name));
	const labels = browser.location.hostname.split(".");
	for (const name of names) {
		const expired = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
		browser.document.cookie = expired;
		for (let i = 0; i < labels.length - 1; i++)
			browser.document.cookie = `${expired}; Domain=.${labels.slice(i).join(".")}`;
	}
}
