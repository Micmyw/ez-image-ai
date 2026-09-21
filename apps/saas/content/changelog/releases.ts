export const publicChangelogEntries = [
	{
		date: "2026-09-21",
		title: "Clearer free editing and guest access",
		changes: [
			"Explain Free account credits and paid plan options in the homepage pricing section.",
			"Clarify when an edit is available without sign-up, how long a guest result lasts, and when sign-in is required.",
			"Keep the limits of free access and flexible prompt editing clear in English, German, Spanish and French.",
		],
	},
	{
		date: "2026-09-20",
		title: "Clearer image preview controls",
		changes: [
			"Close a result preview without losing your prompt, reference image or saved history.",
			"Switch models or return to the homepage without carrying a previously selected result into the new page.",
			"Return from a history detail to the list with a clearly labeled back button, keeping the history panel open.",
		],
	},
	{
		date: "2026-09-19",
		title: "View approved images sooner",
		changes: [
			"Show approved images and enable downloads while credit settlement finishes in the background.",
			"Reduce waiting between generation, image checks and result preparation, with automatic recovery if a step is interrupted.",
		],
	},
	{
		date: "2026-09-16",
		title: "Model inspiration and content reporting",
		changes: [
			"Made the homepage lighter to render and reduced image downloads for compact example cards.",
			"Improved screen-reader names for reference-image, output-setting and example-prompt controls.",
			"Keep the selected plan in view and payment choices steady while switching plans. Credit Packs now share a payment-method selector.",
			"Make unfinished checkout recovery actionable with the previous plan, order reference and a direct support link, while preventing another subscription payment.",
			"Clarified the homepage's image-editing prompts, instructions and FAQ headings in all four interface languages.",
			"Removed repeated creator briefs and made the six examples easier to browse on desktop and mobile.",
			"Added header upgrades, language selection and available credits, with a direct link to Credit Packs.",
			"Keep your selected plan and billing period when opening checkout or signing in, and show clear progress while payment opens.",
			"Prevent repeated payment clicks and offer unfinished checkout recovery in the plan picker.",
			"Make safety notices easier to understand with clear reasons, credit outcomes, next steps, and support links for instructions, images, and guest trials.",
			"Clarify that an unavailable safety result comes from an incomplete automated check, with guidance to try again later.",
			"Restored three clickable portrait model cards below each FAQ, with aligned titles, descriptions, polished hover states and a compact mobile layout.",
			"Kept all 24 previous gallery images, including 11 earlier originals, and added 12 new portraits so every recommendation has its own image.",
			"Fixed Waffo payment availability after store approval and restored its prompt verification on the live service.",
			"Explain content-safety billing before generation: one lifetime waiver per account or team for a blocked result, with later blocked results charged at the quoted amount.",
			"Show clear safety-check and credit outcomes for uploaded images, generated results, and job history.",
			"Added 23 original concept images across all 12 model pages, with a distinct creative direction and matching prompts for each model.",
			"Preserved complete artwork in model recommendations and homepage model previews.",
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
