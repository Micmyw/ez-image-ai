import "server-only";
import type { Effect, EffectExample, EffectPresetTest } from "../../modules/effects/lib/types";

/** Reviewed examples from four authorized product generations. Private evidence is stripped by the public reader. */
// BEGIN REVIEWED 1980S EVIDENCE
const reviewedExamples = [
	{
		id: "studio-portrait-v2-01",
		presetId: "studio-portrait",
		presetVersion: 2,
		caption:
			"A denim jacket, feathered hair and blue-gray backdrop create the studio look. Facial details and the crop changed slightly from the original.",
		input: {
			src: "/images/effects/1980s-ai-photo/input-adult-v1.webp",
			alt: "AI-generated fictional adult woman with a modern bob and gray T-shirt against a plain wall, used as the original reference",
			width: 1000,
			height: 1250,
			rights: {
				kind: "owned",
				holder: "EzImageAI · AI-generated fictional adult",
				evidence: "docs/product/evidence/1980s-ai-photo-2026-09-29.json#input",
				verifiedAt: "2026-09-29T15:56:57.552Z",
			},
		},
		output: {
			src: "/images/effects/1980s-ai-photo/studio-portrait-v2.webp",
			alt: "1980s-inspired studio result with feathered hair, a denim jacket and muted blue-gray backdrop",
			width: 928,
			height: 1152,
			rights: {
				kind: "owned",
				holder: "EzImageAI · reviewed product output",
				evidence: "docs/product/evidence/1980s-ai-photo-2026-09-29.json#attempt-1",
				verifiedAt: "2026-09-29T15:56:57.552Z",
			},
		},
		productKey: "image-nano-banana-2-lite",
		parameters: {
			skuKey: "nano-banana-2-lite-1k",
			aspectRatio: "4:5",
		},
		testedAt: "2026-09-29",
		provenance: {
			kind: "product-generation",
			evidence: "docs/product/evidence/1980s-ai-photo-2026-09-29.json#attempt-1",
		},
	},
	{
		id: "family-snapshot-v3-01",
		presetId: "family-snapshot",
		presetVersion: 3,
		caption:
			"The revised family-album prompt produced natural brown eyes and a closed-mouth smile in this run. The model also added the album border and background decorations.",
		input: {
			src: "/images/effects/1980s-ai-photo/input-adult-v1.webp",
			alt: "AI-generated fictional adult woman with a modern bob and gray T-shirt against a plain wall, used as the original reference",
			width: 1000,
			height: 1250,
			rights: {
				kind: "owned",
				holder: "EzImageAI · AI-generated fictional adult",
				evidence: "docs/product/evidence/1980s-ai-photo-2026-09-29.json#input",
				verifiedAt: "2026-09-29T15:56:57.552Z",
			},
		},
		output: {
			src: "/images/effects/1980s-ai-photo/family-snapshot-v3.webp",
			alt: "AI family-album result with a cream knit sweater, warm living room and generated paper photo border",
			width: 1000,
			height: 747,
			rights: {
				kind: "owned",
				holder: "EzImageAI · reviewed product output",
				evidence: "docs/product/evidence/1980s-ai-photo-2026-09-29.json#attempt-4",
				verifiedAt: "2026-09-29T15:56:57.552Z",
			},
		},
		productKey: "image-nano-banana-2-lite",
		parameters: {
			skuKey: "nano-banana-2-lite-1k",
			aspectRatio: "4:3",
		},
		testedAt: "2026-09-29",
		provenance: {
			kind: "product-generation",
			evidence: "docs/product/evidence/1980s-ai-photo-2026-09-29.json#attempt-4",
		},
	},
	{
		id: "street-portrait-v2-01",
		presetId: "street-portrait",
		presetVersion: 2,
		caption:
			"Warm street light and a denim jacket create the outdoor look. The smile changed, and the cars and blurred pedestrian were generated.",
		input: {
			src: "/images/effects/1980s-ai-photo/input-adult-v1.webp",
			alt: "AI-generated fictional adult woman with a modern bob and gray T-shirt against a plain wall, used as the original reference",
			width: 1000,
			height: 1250,
			rights: {
				kind: "owned",
				holder: "EzImageAI · AI-generated fictional adult",
				evidence: "docs/product/evidence/1980s-ai-photo-2026-09-29.json#input",
				verifiedAt: "2026-09-29T15:56:57.552Z",
			},
		},
		output: {
			src: "/images/effects/1980s-ai-photo/street-portrait-v2.webp",
			alt: "1980s-inspired street result with a denim jacket, soft warm light and blurred city background",
			width: 928,
			height: 1152,
			rights: {
				kind: "owned",
				holder: "EzImageAI · reviewed product output",
				evidence: "docs/product/evidence/1980s-ai-photo-2026-09-29.json#attempt-3",
				verifiedAt: "2026-09-29T15:56:57.552Z",
			},
		},
		productKey: "image-nano-banana-2-lite",
		parameters: {
			skuKey: "nano-banana-2-lite-1k",
			aspectRatio: "4:5",
		},
		testedAt: "2026-09-29",
		provenance: {
			kind: "product-generation",
			evidence: "docs/product/evidence/1980s-ai-photo-2026-09-29.json#attempt-3",
		},
	},
] as const satisfies readonly EffectExample[];

const reviewedTests = [
	{
		exampleId: "studio-portrait-v2-01",
		version: 2,
		prompt:
			"Transform the uploaded portrait into a photorealistic 1980s studio photograph. Use the reference image as the guide for the person's facial structure, skin tone, apparent age, and expression; do not deliberately change their identity. Add a softly feathered hairstyle and a period-inspired denim jacket over a plain shirt. Use a muted blue-gray studio backdrop, soft portrait lighting, gentle diffusion, subtle 35mm film grain, and restrained faded color. Keep natural skin texture and realistic anatomy. Avoid neon cyberpunk styling, cartoon rendering, text, watermarks, and deliberate beauty reshaping.",
		productKey: "image-nano-banana-2-lite",
		parameters: {
			skuKey: "nano-banana-2-lite-1k",
			aspectRatio: "4:5",
		},
		testedAt: "2026-09-29",
		outcome: "passed",
		evidence: "docs/product/evidence/1980s-ai-photo-2026-09-29.json#attempt-1",
	},
	{
		exampleId: "family-snapshot-v3-01",
		version: 3,
		prompt:
			"Restyle the uploaded portrait as a family-album photograph inspired by the 1980s. Follow the reference image for the person's facial structure, skin tone, and apparent age, and keep the same relaxed closed-mouth expression. Show the same person in a simple period-inspired knit sweater in a modest living-room setting, without adding other people. Use gentle off-axis bounced-flash lighting, warm indoor tones, mild print fading, and fine consumer-film grain. Keep the eyes naturally brown without red-eye, and keep the face and eyes free of scratches, dust, or damage overlays. Keep the scene believable and the person recognizable as a goal, not a guaranteed result. Avoid heavy beauty retouching, captions, watermarks, and cartoon effects.",
		productKey: "image-nano-banana-2-lite",
		parameters: {
			skuKey: "nano-banana-2-lite-1k",
			aspectRatio: "4:3",
		},
		testedAt: "2026-09-29",
		outcome: "passed",
		evidence: "docs/product/evidence/1980s-ai-photo-2026-09-29.json#attempt-4",
	},
	{
		exampleId: "street-portrait-v2-01",
		version: 2,
		prompt:
			"Create a photorealistic 1980s-inspired street portrait from the uploaded reference photo. Use the person's facial structure, skin tone, apparent age, and expression as the identity guide. Style the person with a denim jacket, a plain T-shirt, and restrained period-inspired hair. Place them on an ordinary city street in soft late-afternoon light, with an unobtrusive background and no readable signs. Use muted warm colors, natural shadows, mild film grain, and realistic skin texture. Avoid neon sci-fi scenery, exaggerated fashion, deliberate facial reshaping, extra fingers, text, and watermarks.",
		productKey: "image-nano-banana-2-lite",
		parameters: {
			skuKey: "nano-banana-2-lite-1k",
			aspectRatio: "4:5",
		},
		testedAt: "2026-09-29",
		outcome: "passed",
		evidence: "docs/product/evidence/1980s-ai-photo-2026-09-29.json#attempt-3",
	},
] as const satisfies readonly EffectPresetTest[];
// END REVIEWED 1980S EVIDENCE

export const eightiesPhotoEffect = {
	id: "1980s-ai-photo",
	slug: "1980s-ai-photo",
	title: "1980s AI Photo Prompts & Photo Maker",
	summary:
		"Use a reference photo and a 1980s prompt to try studio portraits, warm family snapshots, or street photography. Copy a recipe or edit it here. Facial details can change, so compare each result with your original.",
	seoTitle: "1980s AI Photo Prompts & Retro Photo Maker | EzImageAI",
	seoDescription:
		"Copy 1980s AI photo prompts, compare retro portrait examples, and upload your photo to try studio, family-snapshot, and street styles in EzImageAI.",
	primaryQuery: "1980s ai photo prompt",
	queryCluster: ["80s photo prompt", "retro portrait prompt", "80s retro photo maker"],
	primaryCategoryId: "retro-vintage",
	tags: ["retro", "portrait", "family", "street"],
	status: "published",
	trendStage: "none",
	featuredOrder: 0,
	cover: reviewedExamples[0].output,
	examples: reviewedExamples,
	defaultPresetId: "studio-portrait",
	presets: [
		{
			id: "studio-portrait",
			version: 2,
			name: "Soft-focus studio portrait",
			prompt:
				"Transform the uploaded portrait into a photorealistic 1980s studio photograph. Use the reference image as the guide for the person's facial structure, skin tone, apparent age, and expression; do not deliberately change their identity. Add a softly feathered hairstyle and a period-inspired denim jacket over a plain shirt. Use a muted blue-gray studio backdrop, soft portrait lighting, gentle diffusion, subtle 35mm film grain, and restrained faded color. Keep natural skin texture and realistic anatomy. Avoid neon cyberpunk styling, cartoon rendering, text, watermarks, and deliberate beauty reshaping.",
			inputRequirement: "required",
			inputHint:
				"Choose a clear, well-lit portrait of one person with room above the head. The studio recipe changes hair, clothing, and backdrop; it is not an identity-locking tool.",
			productKey: "image-nano-banana-2-lite",
			parameters: { skuKey: "nano-banana-2-lite-1k", aspectRatio: "4:5" },
			exampleIds: [reviewedExamples[0].id],
			tests: [reviewedTests[0]],
		},
		{
			id: "family-snapshot",
			version: 3,
			name: "Family-album snapshot",
			prompt:
				"Restyle the uploaded portrait as a family-album photograph inspired by the 1980s. Follow the reference image for the person's facial structure, skin tone, and apparent age, and keep the same relaxed closed-mouth expression. Show the same person in a simple period-inspired knit sweater in a modest living-room setting, without adding other people. Use gentle off-axis bounced-flash lighting, warm indoor tones, mild print fading, and fine consumer-film grain. Keep the eyes naturally brown without red-eye, and keep the face and eyes free of scratches, dust, or damage overlays. Keep the scene believable and the person recognizable as a goal, not a guaranteed result. Avoid heavy beauty retouching, captions, watermarks, and cartoon effects.",
			inputRequirement: "required",
			inputHint:
				"Use a clear single-person portrait. This recipe creates a living-room snapshot; the model may invent borders or background decorations. Group-photo preservation has not been tested.",
			productKey: "image-nano-banana-2-lite",
			parameters: { skuKey: "nano-banana-2-lite-1k", aspectRatio: "4:3" },
			exampleIds: [reviewedExamples[1].id],
			tests: [reviewedTests[1]],
		},
		{
			id: "street-portrait",
			version: 2,
			name: "Late-afternoon street portrait",
			prompt:
				"Create a photorealistic 1980s-inspired street portrait from the uploaded reference photo. Use the person's facial structure, skin tone, apparent age, and expression as the identity guide. Style the person with a denim jacket, a plain T-shirt, and restrained period-inspired hair. Place them on an ordinary city street in soft late-afternoon light, with an unobtrusive background and no readable signs. Use muted warm colors, natural shadows, mild film grain, and realistic skin texture. Avoid neon sci-fi scenery, exaggerated fashion, deliberate facial reshaping, extra fingers, text, and watermarks.",
			inputRequirement: "required",
			inputHint:
				"Start with one person and a clearly visible face and torso. Check newly generated clothing edges, hands, and background details before sharing.",
			productKey: "image-nano-banana-2-lite",
			parameters: { skuKey: "nano-banana-2-lite-1k", aspectRatio: "4:5" },
			exampleIds: [reviewedExamples[2].id],
			tests: [reviewedTests[2]],
		},
	],
	instructions: [
		{
			title: "Choose a photo you have permission to edit",
			body: "Start with a clear original. Make sure every person who appears in your source is appropriate for the edit and that you have the necessary rights to use the photograph.",
		},
		{
			title: "Choose a direction and review the prompt",
			body: "Pick the studio, family-album, or street preset. Copy its prompt or adjust the details in the editor to suit your own photo.",
		},
		{
			title: "Review the available settings before generating",
			body: "Upload your photo, inspect the editor's current model availability and credit quote, and generate only when you are ready. Selecting a preset does not submit an edit.",
		},
		{
			title: "Compare the result with your original",
			body: "Compare the face, hairstyle, hands, clothing edges, and background with your original. If too much changes, try removing one styling instruction or return to the original; these are adjustments to try, not a guarantee of identity preservation.",
		},
	],
	limitations: [
		"Facial details, expression, hairstyle, and framing can change. These examples show one fictional adult reference and do not establish a success rate or reliable identity preservation.",
		"A request to preserve identity does not guarantee unchanged facial features. Compare every face with the original before sharing a result.",
		"Crowded scenes, obscured faces, small subjects, text, and complex clothing can produce missing or altered details.",
		"These are AI interpretations of 1980s photography, not historical photographs. Clothing and other period details may be inaccurate, and repeated runs can change the composition, face, and colors.",
		"The family-album result added a paper border and background decorations; the street result changed the smile and added background scenery. Hands, groups, and full-body photographs were not tested.",
		"Model availability, account eligibility, usage limits, and the current credit quote are determined by the editor. Normal content and legal requirements apply.",
	],
	faq: [
		{
			question: "What kind of original photo should I upload?",
			answer:
				"Start with a clear, well-lit photo of one adult, with the face and shoulders visible and space above the head. The three examples use the same AI-generated fictional adult. They do not show results for children, groups, obscured faces, or full-body photos.",
		},
		{
			question: "Which 1980s photo style should I choose?",
			answer:
				"Choose Studio for a denim jacket, feathered hair and a muted backdrop; Family-album for a knit sweater and warm living room; or Street for denim and late-afternoon city light. Each preview shows one actual result, including details the model added on its own.",
		},
		{
			question: "Can I copy a prompt without uploading a photo?",
			answer:
				"Yes. A published prompt can be read and copied without starting a generation. These photo-editing presets are designed to use a source image when you generate.",
		},
		{
			question: "Will the edit keep every face identical?",
			answer:
				"No. A reference photo guides the result, but facial proportions, expression, and apparent age may still change. Compare each output with your original. These single-person recipes do not establish results for group photos.",
		},
		{
			question: "Does choosing a preset spend credits?",
			answer:
				"Choosing a preset prepares the editor. Review the live settings and quote before explicitly submitting a generation; existing eligibility and billing rules still apply.",
		},
		{
			question: "Are these preview images really generated in EzImageAI?",
			answer:
				"Yes. The three displayed outputs were generated through EzImageAI with Nano Banana 2 Lite at 1K on September 29, 2026, using the exact prompt versions and aspect ratios shown here. The original is an AI-generated fictional adult created separately as the common reference. Four product runs were reviewed; an earlier family-album result with red-eye was excluded. The images were resized or compressed for the web, without creative retouching.",
		},
		{
			question: "What helped with unwanted face changes in this test?",
			answer:
				"The first family-album run added red-eye and an open smile. A second run used a revised prompt asking for gentle off-axis bounced flash, natural brown eyes and the same closed-mouth expression; that output had no obvious red-eye and kept a closed mouth. Several instructions changed together, so this single comparison does not prove which instruction caused the improvement or guarantee the same outcome on another photo.",
		},
		{
			question: "Do I need an account, and what does generation cost?",
			answer:
				"Reading and copying these prompts does not require an upload or payment. Generation uses the editor's current guest eligibility or account access rules. Check its live credit quote, model availability and limits before starting. Your own inputs and results remain in the existing private media workflow; they are not added to this public example library.",
		},
	],
	relatedEffectIds: [],
	publishedAt: "2026-09-29",
	updatedAt: "2026-09-29",
	lastTestedAt: "2026-09-29",
} as const satisfies Effect;
