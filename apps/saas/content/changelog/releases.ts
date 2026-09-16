export const publicChangelogEntries = [
	{
		date: "2026-09-16",
		title: "Content policy and reporting",
		changes: [
			"Expanded the Terms of Service with prohibited content, moderation, enforcement, and appeals.",
			"Added a Report content link in the footer and instructions on the Contact page, available without an account.",
			"Display the support email address directly in public, sign-in, and documentation footers.",
			"Published response and handling times for all four report severity levels.",
		],
	},
	{
		date: "2026-09-15",
		title: "Lighter homepage on mobile",
		changes: [
			"Keep the initial page smaller and reuse cached styles across visits.",
			"Reduced the code downloaded for a first visit while keeping the image generator ready to use.",
			"Load account tools when signed in, with the full editor and account navigation still available.",
		],
	},
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
