export const publicChangelogEntries = [
	{
		date: "2026-08-31",
		title: "Unified public image editor",
		changes: [
			"Moved the upload-first EzPic experience to the same-origin SaaS homepage.",
			"Added server-advertised Standard and Quality tier selection without exposing Provider or model details to the browser.",
			"Preserved the selected source image, prompt, and tier across retryable guest-draft failures.",
		],
	},
	{
		date: "2026-08-28",
		title: "Private anonymous Standard trial",
		changes: [
			"Added a bounded anonymous trial path with a temporary owner, private source media, and a watermarked result.",
			"Added expiry-aware cleanup and account-link behavior without transferring sponsored credits or extending retention.",
		],
	},
	{
		date: "2026-08-25",
		title: "EzPic source-image editing foundation",
		changes: [
			"Specialized the product around source-image-required Standard and Quality edits.",
			"Kept real quotes, credit reservation, job creation, moderation, and private media ownership on server-controlled paths.",
		],
	},
] as const;
