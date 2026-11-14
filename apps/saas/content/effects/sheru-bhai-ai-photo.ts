import type { Effect, EffectAsset } from "../../modules/effects/lib/types";

const evidence = "docs/product/sheru-bhai-ai-photo-2026-11-13.md";
const artwork = (name: string, alt: string): EffectAsset => ({
	src: `/images/effects/sheru-bhai-ai-photo/${name}.webp`,
	alt,
	width: 896,
	height: 1120,
	rights: {
		kind: "owned",
		holder: "AI-created illustration for EzImageAI",
		evidence,
		verifiedAt: "2026-11-13",
	},
});
const withSheru = artwork(
	"with-sheru",
	"Style illustration: a woman in teal beside a white lion in an ivory suit in a palace courtyard",
);
const becomeSheru = artwork(
	"become-sheru",
	"Style illustration: a white lion-headed figure wearing a charcoal jacket at a palace entrance",
);
const parameters = { skuKey: "nano-banana-2-1k", aspectRatio: "4:5", outputFormat: "png" } as const;

export const sheruBhaiPhotoEffect: Effect = {
	id: "sheru-bhai-ai-photo",
	slug: "sheru-bhai-ai-photo",
	title: "Sheru Bhai AI Photo Prompts",
	summary:
		"Choose Photo with Sheru or Turn me into Sheru, then upload your photo to create a lion-boss portrait.",
	seoTitle: "Sheru Bhai AI Photo Prompt: 2 Looks to Try",
	seoDescription:
		"Try two Sheru Bhai AI photo prompt presets: Photo with Sheru or Turn me into Sheru. Choose a look, upload your photo and create with Nano Banana 2.",
	primaryQuery: "sheru bhai ai photo",
	queryCluster: [
		"sheru bhai ai photo prompt",
		"sheru bhai ai photo editing prompt",
		"sheru bhai ai photo editor",
		"photo with sheru bhai",
	],
	primaryCategoryId: "portraits",
	tags: ["portrait", "illustration"],
	status: "published",
	trendStage: "none",
	generationAccess: "paid",
	presentation: "illustrations",
	cover: withSheru,
	examples: [],
	illustrations: [
		{
			id: "with-sheru-art",
			presetId: "with-sheru",
			presetVersion: 1,
			image: withSheru,
			caption: "You and the white-lion boss, side by side.",
			provenance: { kind: "editorial-generation", evidence },
		},
		{
			id: "become-sheru-art",
			presetId: "become-sheru",
			presetVersion: 1,
			image: becomeSheru,
			caption: "Your outfit. A white lion's head.",
			provenance: { kind: "editorial-generation", evidence },
		},
	],
	defaultPresetId: "with-sheru",
	presets: [
		{
			id: "with-sheru",
			version: 1,
			name: "Photo with Sheru",
			inputRequirement: "required",
			inputHint: "Add a clear solo portrait. You stay human; the lion stands beside you.",
			productKey: "image-nano-banana-2",
			parameters,
			exampleIds: [],
			tests: [],
			prompt:
				"Use the uploaded photo as the identity reference for the human subject. Create a realistic waist-up portrait of this person standing beside a separate fictional Sheru Bhai-inspired white lion businessman in a warm sandstone palace courtyard. Preserve the person's facial features, skin tone, hairstyle, expression and clothing as closely as possible. Keep the person entirely human: do not change their head, face or hands into an animal. The second subject has a proportional white lion head, a full cream-white mane, calm amber eyes, an ivory tailored suit and one understated gold chain. Exactly two separate subjects, both facing the camera with relaxed expressions. Leave a little space between their shoulders; no touching or overlapping limbs. Keep hands outside the frame. Match the light, perspective and scale of both subjects. Warm late-afternoon light, natural skin, detailed fur and fabric, subtle architectural background, believable editorial photography. Keep both heads comfortably within a vertical 4:5 frame. No additional people, merged bodies, duplicate faces, text, logos, watermarks, weapons or crowns.",
		},
		{
			id: "become-sheru",
			version: 1,
			name: "Turn me into Sheru",
			inputRequirement: "required",
			inputHint: "Add a standing photo with your outfit visible. Your head becomes a lion's.",
			productKey: "image-nano-banana-2",
			parameters,
			exampleIds: [],
			tests: [],
			prompt:
				"Transform the single person in the uploaded photo into a fictional Sheru Bhai-inspired white lion-headed character. Replace only the person's head with a realistic white lion head and full cream-white mane, naturally joined to the neck and shoulders at the collar. Keep their body proportions, clothing, clothing colors, accessories and standing pose as closely as possible. Do not replace their outfit with a suit. The lion has calm amber eyes and a closed mouth, looking toward the camera. Use a quiet sandstone palace entrance at twilight with soft warm architectural light and cool ambient shadows. Exactly one character, believable head-to-body scale, detailed fur and fabric, natural fashion photography. Frame the character vertically at 4:5, keeping the complete head and mane inside the frame. Keep hands relaxed or outside the crop; do not create additional hands or paws. No remaining human face blended into the muzzle, floating head, additional animals, people, roaring, text, logos, watermarks, weapons, crowns or sunglasses.",
		},
	],
	instructions: [
		{
			title: "Choose your look",
			body: "Stay yourself beside Sheru, or turn your own head into a lion's.",
		},
		{
			title: "Add your photo",
			body: "Upload a clear photo of one person that you have permission to edit. Your selected preset supplies the generation instructions.",
		},
		{
			title: "Create your portrait",
			body: "Click Generate. If you need access, choose an image pack or a subscription, then return to your prepared photo.",
		},
	],
	limitations: [
		"The artwork shows the intended style and was created separately from the EzImageAI editor. Your generated result will vary.",
		"Facial details, outfits and proportions can change. Check the result before sharing.",
	],
	faq: [
		{
			question: "How do I make a photo with Sheru Bhai?",
			answer:
				"Choose Photo with Sheru, upload a clear solo portrait and click Generate. This preset keeps you human and adds a separate white-lion character beside you.",
		},
		{
			question: "Can I turn myself into the lion?",
			answer:
				"Yes. Choose Turn me into Sheru and upload a standing photo with your clothes visible. This mode replaces your head with a lion head; it does not preserve your human face.",
		},
		{
			question: "Is this template free?",
			answer:
				"You can select a preset and upload your photo before buying. Generation requires any image pack with remaining uses or an active paid subscription with enough credits. When needed, Generate offers the $2.99 pack for three successful images, with no subscription, or other plans. Free sign-in credits alone do not unlock this template.",
		},
		{
			question: "Do I need to write a Sheru Bhai AI photo editing prompt?",
			answer:
				"No. Select Photo with Sheru or Turn me into Sheru and upload your photo. The preset supplies the generation instructions automatically; you do not need to write a prompt.",
		},
		{
			question: "Are these pictures actual EzImageAI results?",
			answer:
				"They are AI-created style illustrations made separately for this page, not outputs from this template in the EzImageAI editor. They show the direction of each look rather than a guaranteed result.",
		},
		{
			question: "Is this an official Sheru Bhai app?",
			answer:
				"EzImageAI is an independent image editor. These are fictional, AI-generated portraits inspired by the trend. We are not affiliated with a trend creator or social platform.",
		},
	],
	relatedEffectIds: ["1980s-ai-photo"],
	publishedAt: "2026-11-13",
	updatedAt: "2026-11-14",
};
