// Paths with complete, immutable Next route responses in the same build.
export const prerenderedMetadata = {
	"/sitemap.xml": "application/xml",
	"/sitemap-images.xml": "application/xml; charset=utf-8",
	"/robots.txt": "text/plain",
	"/icon.png": "image/png",
};

// Keep the bytes at namespaced URLs so OpenNext can still route an authenticated
// navigation to an organization whose historical slug matches a browser filename.
export const publicIcons = {
	"/favicon.ico": "/images/branding/favicon.ico",
	"/apple-touch-icon.png": "/images/branding/apple-touch-icon.png",
};

// EzPic does not currently advertise an installable app.
export const webManifestPaths = ["/manifest.json", "/manifest.webmanifest", "/site.webmanifest"];

export const workerFirstMetadataPaths = [
	...Object.keys(prerenderedMetadata),
	...Object.keys(publicIcons),
	...webManifestPaths,
];
