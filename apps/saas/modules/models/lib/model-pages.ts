import type { EZPIC_PRODUCT_KEYS } from "@repo/config/client";

import type { InspirationKey } from "./model-artwork";

export type ModelProductKey = (typeof EZPIC_PRODUCT_KEYS)[number];
export { INSPIRATION } from "./model-artwork";

export interface ModelPageContent {
	key: ModelProductKey;
	updatedAt: string;
	name: string;
	family: "GPT Image" | "Nano Banana" | "Seedream";
	lead: string;
	description: string;
	tags: readonly string[];
	artwork: InspirationKey;
	exampleArtwork: InspirationKey;
	beforeArtwork?: InspirationKey;
	recommendationArtwork: readonly [InspirationKey, InspirationKey, InspirationKey];
	features: readonly { title: string; description: string }[];
	tip: string;
	review: string;
}

export const MODEL_PAGES: readonly ModelPageContent[] = [
	{
		key: "image-gpt-image-2",
		updatedAt: "2026-09-16",
		recommendationArtwork: ["gpt-poster", "gpt-2-solar-poster", "gpt-2-tidal-poster"],
		name: "GPT Image 2",
		family: "GPT Image",
		lead: "Let words become the image.",
		description:
			"Explore typographic posters and graphic compositions. Bring exact lettering, a strong focal point, and a deliberate layout into one creative brief.",
		tags: ["Typography", "Poster design", "Graphic composition"],
		artwork: "gpt-2-jazz-poster",
		exampleArtwork: "gpt-2-moon-cinema",
		features: [
			{
				title: "Give every element a place",
				description:
					"Describe the foreground, background, focal point, and negative space together. A clear hierarchy gives complex scenes a direction and makes each new iteration easier to judge.",
			},
			{
				title: "Design with words and images",
				description:
					"Put exact headlines in quotation marks and describe their placement, size, and relationship to the artwork. Start with a short headline for a poster, cover, or packaging concept.",
			},
			{
				title: "Direct the material and the light",
				description:
					"Name the surfaces you want to see: frosted glass, brushed metal, woven fabric. Pair them with a lighting brief to explore product photography and campaign ideas.",
			},
		],
		tip: "Write the layout first, then the subject and style. Keep exact lettering separate from descriptive instructions.",
		review:
			"Check spelling, small lettering, object counts, and the placement of important details before publishing.",
	},
	{
		key: "image-gpt-image-2-5-flare",
		updatedAt: "2026-09-16",
		recommendationArtwork: ["gpt-flare-studio", "nano-portrait", "gpt-flare-florist"],
		name: "GPT Image 2.5 Flare",
		family: "GPT Image",
		lead: "Everyday ideas, with a little more atmosphere.",
		description:
			"Explore portraits, lifestyle imagery, and everyday creative concepts with a focus on natural detail and a clear visual brief.",
		tags: ["Documentary photography", "Natural light", "Everyday moments"],
		artwork: "gpt-flare-luthier",
		exampleArtwork: "gpt-flare-flower-stall",
		features: [
			{
				title: "Find the scene in an everyday moment",
				description:
					"Begin with a specific action and setting: a glance across a street, a quiet kitchen, a walk after rain. Small observable details make a portrait brief more expressive.",
			},
			{
				title: "Give light a direction",
				description:
					"Describe the time of day, the source of light, and the mood. Window light, overcast daylight, and warm cafe lamps lead to very different creative directions.",
			},
			{
				title: "Iterate with a reference",
				description:
					"Add a reference when an existing subject or composition matters. State which features to retain and choose one change at a time so you can evaluate the result.",
			},
		],
		tip: "Use a short scene description, one lighting direction, and a few material details before adding more instructions.",
		review: "Review faces, hands, and any reference details that must remain recognizable.",
	},
	{
		key: "image-gpt-image-2-5-sunburst",
		updatedAt: "2026-09-16",
		recommendationArtwork: ["gpt-campaign", "gpt-sunburst-cyclist", "gpt-sunburst-tennis"],
		name: "GPT Image 2.5 Sunburst",
		family: "GPT Image",
		lead: "Give your next campaign a clear direction.",
		description:
			"Explore sports and fashion campaigns with expressive movement, bold color, and deliberate lighting. Build a visual brief around the person, fabric, and setting.",
		tags: ["Sports campaigns", "Fashion concepts", "Color and motion"],
		artwork: "gpt-sunburst-sprinter",
		exampleArtwork: "gpt-sunburst-windbreaker",
		features: [
			{
				title: "Build a visual system",
				description:
					"Choose a small palette, a lighting treatment, and a set of materials. Carry that brief across individual campaign concepts to explore a coherent visual direction.",
			},
			{
				title: "Make the product the focal point",
				description:
					"Specify the camera angle and the space around your subject. Use supporting props to explain a mood or ingredient without competing with the main object.",
			},
			{
				title: "Refine a creative decision",
				description:
					"Try a different backdrop, surface, or light direction while keeping the rest of the brief stable. Use a reference to guide the next iteration when you have a composition worth keeping.",
			},
		],
		tip: "Describe the campaign mood, product material, camera angle, and background as separate parts of one brief.",
		review:
			"Verify packaging geometry, product details, and any marketing text; concept imagery still needs a publishing review.",
	},
	{
		key: "image-gpt-image-1-5",
		updatedAt: "2026-09-16",
		recommendationArtwork: ["gpt-15-paper-world", "gpt-15-paper-forest", "gpt-15-paper-garden"],
		name: "GPT Image 1.5",
		family: "GPT Image",
		lead: "From a clear instruction to a considered image.",
		description:
			"Explore paper sculptures, miniature worlds, and reference-based changes with explicit instructions and a choice of Medium or High quality.",
		tags: ["Paper craft", "Miniature worlds", "Medium / High"],
		artwork: "gpt-15-paper-lighthouse",
		exampleArtwork: "gpt-15-paper-balloon",
		features: [
			{
				title: "Start with a compact brief",
				description:
					"Describe what belongs in the frame, what should stand out, and what should be left out. Use a focused concept to establish a baseline before refining it.",
			},
			{
				title: "Choose a quality setting deliberately",
				description:
					"The editor exposes Medium and High settings for this model. Review the quoted credits for your chosen setting before starting the generation.",
			},
			{
				title: "Carry an existing image forward",
				description:
					"Upload a reference and describe the change in ordinary language. Mention the subject, layout, or palette you want to keep alongside the new instruction.",
			},
		],
		tip: "For a reference edit, split the brief into what changes and what stays. For a new image, start with composition and subject.",
		review:
			"Check text, fine lines, and repeated objects. A higher setting does not guarantee every detail will be correct.",
	},
	{
		key: "image-nano-banana-2-lite",
		updatedAt: "2026-09-16",
		recommendationArtwork: ["nano-bakery-fox", "nano-lite-penguin", "nano-lite-otter"],
		name: "Nano Banana 2 Lite",
		family: "Nano Banana",
		lead: "A focused starting point for your next idea.",
		description:
			"Explore playful 3D mascots and character-led social visuals with a straightforward 1K output setting. Start with one readable silhouette and a little personality.",
		tags: ["3D mascots", "Social concepts", "1K output"],
		artwork: "nano-lite-capybara",
		exampleArtwork: "nano-lite-toaster",
		features: [
			{
				title: "Keep the output choice simple",
				description:
					"Lite uses a fixed 1K output tier. Concentrate on the subject, crop, and style while checking the current credit quote in the editor.",
			},
			{
				title: "Try a character or a mood",
				description:
					"Describe an expression, outfit, setting, and light source. A focused scene helps you explore ideas for profile imagery, social cards, and story concepts.",
			},
			{
				title: "Change one creative variable",
				description:
					"Try a new color palette or a different background while keeping the central idea stable. Add a reference when you want the composition to begin from an existing image.",
			},
		],
		tip: "Keep the concept readable at a small size. Use one clear subject and a background that supports it.",
		review:
			"Review fine details at the actual output size. Choose another model when your workflow requires a larger output tier.",
	},
	{
		key: "image-nano-banana",
		updatedAt: "2026-09-16",
		recommendationArtwork: ["nano-rabbit-orchard", "nano-hedgehog-bookshop", "nano-deer-lantern"],
		name: "Nano Banana",
		family: "Nano Banana",
		lead: "One idea. Plenty of creative directions.",
		description:
			"Explore watercolor storybooks and gentle illustrated worlds with natural-language prompts and optional reference images. Describe the characters, scene, and painted texture.",
		tags: ["Watercolor stories", "Illustrated characters", "Reference edits"],
		artwork: "nano-whale-library",
		exampleArtwork: "nano-mouse-tea",
		features: [
			{
				title: "Move between visual styles",
				description:
					"Give the same subject different treatments: an editorial photograph, a soft illustration, or a graphic composition. Describe the medium and texture explicitly.",
			},
			{
				title: "Put a subject in context",
				description:
					"Connect the person or object to a setting, action, and mood. Concrete scene details are more useful than a long list of abstract quality words.",
			},
			{
				title: "Build on a reference",
				description:
					"Use an existing image as a starting point, then name the background, color, or lighting change. Review the new image for the details you intended to preserve.",
			},
		],
		tip: "Name a medium, a subject, and a lighting style. Refine the strongest direction with small prompt changes.",
		review:
			"Inspect identity, object proportions, and style consistency across separate generations.",
	},
	{
		key: "image-nano-banana-2",
		updatedAt: "2026-09-16",
		recommendationArtwork: ["nano-2-rooftop", "nano-2-moon-tram", "nano-2-airship-harbor"],
		name: "Nano Banana 2",
		family: "Nano Banana",
		lead: "Explore a look. Then develop the details.",
		description:
			"Explore comic illustration and line-art color studies with reference guidance and a choice of 1K, 2K, or 4K output. Develop the drawing, palette, and story together.",
		tags: ["Comic illustration", "Color studies", "1K / 2K / 4K"],
		artwork: "nano-2-dragon-courier",
		exampleArtwork: "nano-2-coloring-after",
		beforeArtwork: "nano-2-coloring-before",
		features: [
			{
				title: "Set the story in a single frame",
				description:
					"Define the main subject, the action, and the surrounding scene. Use framing and lighting to establish a mood before expanding the prompt.",
			},
			{
				title: "Develop a visual direction",
				description:
					"Try an outfit, palette, or setting change with an optional reference. Keep the features that matter explicit in the brief instead of assuming they will carry over.",
			},
			{
				title: "Match the output to the task",
				description:
					"Choose among the output tiers offered in the editor. A social concept and a larger presentation visual may call for different settings and credit budgets.",
			},
		],
		tip: "Use the same creative brief when comparing settings so you can judge the output without changing several variables.",
		review:
			"Review faces, fine textures, and continuity when building a sequence of related images.",
	},
	{
		key: "image-nano-banana-pro",
		updatedAt: "2026-09-16",
		recommendationArtwork: ["nano-product", "nano-pro-watch", "nano-pro-camera-study"],
		name: "Nano Banana Pro",
		family: "Nano Banana",
		lead: "Make the material part of the story.",
		description:
			"Explore polished product scenes, editorial still life, and detailed visual concepts with 1K, 2K, and 4K output options.",
		tags: ["Product photography", "Material studies", "1K / 2K / 4K"],
		artwork: "nano-pro-camera",
		exampleArtwork: "nano-pro-glass-perfume",
		features: [
			{
				title: "Art-direct a product scene",
				description:
					"Specify the product position, camera angle, surface, and backdrop. A strong product composition gives accessories and supporting props a clear role.",
			},
			{
				title: "Explore light on real materials",
				description:
					"Use specific texture language for glass, metal, fabric, or ceramics. Describe the reflection and shadow you want to see instead of relying on a generic studio look.",
			},
			{
				title: "Refine the presentation",
				description:
					"Review a concept before choosing a larger output tier. Add a reference to guide the next version when an existing silhouette or composition is essential.",
			},
		],
		tip: "Describe the light source and material finish together: brushed metal in hard sunlight behaves differently from polished metal in a softbox.",
		review:
			"Check product geometry, reflections, logos, and small text against the real item before commercial use.",
	},
	{
		key: "image-seedream-4",
		updatedAt: "2026-09-16",
		recommendationArtwork: ["seedream-interior", "seedream-5-pro-museum", "seedream-4-stairwell"],
		name: "Seedream 4.0",
		family: "Seedream",
		lead: "Give a space its own atmosphere.",
		description:
			"Explore architectural interiors and spatial concepts with flexible output sizes. Describe the proportions, materials, daylight, and view beyond the room.",
		tags: ["Architecture", "Interior concepts", "1K / 2K / 4K"],
		artwork: "seedream-4-reading-pavilion",
		exampleArtwork: "seedream-4-tea-room",
		features: [
			{
				title: "Build the frame from big shapes",
				description:
					"Place the major forms first: an arch, a window, a landscape silhouette. Describe where the viewer should look and how the surrounding space supports it.",
			},
			{
				title: "Choose a restrained palette",
				description:
					"A small set of colors can give an interior, still life, or illustrated scene a strong identity. Add material texture after establishing the composition.",
			},
			{
				title: "Explore different output sizes",
				description:
					"Use the output settings to match the image to your next step, whether you are reviewing a concept or preparing a larger visual. Credits are shown before submission.",
			},
		],
		tip: "Start with composition and palette, then describe one or two tactile surfaces that give the scene character.",
		review:
			"Check perspective, furniture proportions, and structural details in architecture or interiors.",
	},
	{
		key: "image-seedream-4-5",
		updatedAt: "2026-09-16",
		recommendationArtwork: [
			"seedream-45-botanical",
			"seedream-45-koi-print",
			"seedream-45-heron-print",
		],
		name: "Seedream 4.5",
		family: "Seedream",
		lead: "Find a rhythm in color and shape.",
		description:
			"Explore printmaking, surface patterns, and coordinated graphic collections with Basic 2K and High 4K output choices. Build a visual rhythm from a small palette and recurring shapes.",
		tags: ["Printmaking", "Surface patterns", "2K / 4K"],
		artwork: "seedream-45-crane-print",
		exampleArtwork: "seedream-45-citrus-pattern",
		features: [
			{
				title: "Start with a repeating visual rhythm",
				description:
					"Choose a few recognizable motifs and describe their spacing, scale, and direction. Alternating large and small shapes gives a print or surface pattern a clear rhythm.",
			},
			{
				title: "Carry a visual idea across a collection",
				description:
					"Choose a small palette, a printing texture, and one recurring shape. Use that shared brief to explore fabric patterns, art prints, or stationery with a recognizable design language.",
			},
			{
				title: "Choose between two output tiers",
				description:
					"The editor pairs Basic with 2K and High with 4K for this model. Review the selected tier and its credits before generating.",
			},
		],
		tip: "Describe the motifs, limited palette, spacing, and print texture. If you need a seamless repeat, check every edge before using the pattern.",
		review:
			"Review motif consistency, margins, and pattern edges. An attractive pattern is not automatically a seamless tile.",
	},
	{
		key: "image-seedream-5-lite",
		updatedAt: "2026-09-16",
		recommendationArtwork: [
			"seedream-lite-lynx",
			"seedream-lite-hummingbird",
			"seedream-lite-kingfisher-portrait",
		],
		name: "Seedream 5 Lite",
		family: "Seedream",
		lead: "Let the natural world set the mood.",
		description:
			"Explore wildlife portraits and natural environments with Basic 2K, High 3K, and Ultra 4K choices. Set the subject in a believable habitat with a clear lighting brief.",
		tags: ["Wildlife photography", "Natural atmosphere", "2K / 3K / 4K"],
		artwork: "seedream-lite-arctic-fox",
		exampleArtwork: "seedream-lite-kingfisher",
		features: [
			{
				title: "Connect a subject to its habitat",
				description:
					"Choose an animal, a camera viewpoint, and a believable environment. Describe the pose and the space around the subject before adding fine fur or feather details.",
			},
			{
				title: "Use atmosphere deliberately",
				description:
					"Describe fog, weather, time of day, and the direction of light. Keep the palette focused so that the brightest part of the image supports the subject.",
			},
			{
				title: "Develop the image in stages",
				description:
					"Explore the composition before changing output settings. The available tiers let you choose the size and credit budget for the next iteration.",
			},
		],
		tip: "Write the camera shot, subject scale, weather, and light source. Avoid stacking several conflicting lighting styles.",
		review:
			"Check animal anatomy, feet, fur or feathers, and whether the habitat and light form a believable scene.",
	},
	{
		key: "image-seedream-5-pro",
		updatedAt: "2026-09-16",
		recommendationArtwork: [
			"seedream-pro-observatory",
			"seedream-pro-lunar-train",
			"seedream-pro-desert-portal",
		],
		name: "Seedream 5 Pro",
		family: "Seedream",
		lead: "Imagine a world beyond the everyday.",
		description:
			"Explore cinematic science-fiction worlds and speculative environments with Basic 1K or High 2K output. Use scale, atmosphere, and a clear focal point to build the scene.",
		tags: ["Science-fiction worlds", "Cinematic scale", "1K / 2K"],
		artwork: "seedream-pro-orbital-garden",
		exampleArtwork: "seedream-pro-undersea-city",
		features: [
			{
				title: "Direct the scene as a whole",
				description:
					"Connect the main subject to the setting, scale, and light. Use the brief to explain how the elements relate instead of describing each object in isolation.",
			},
			{
				title: "Give details a purpose",
				description:
					"Select the materials and props that support the story. Keep the composition readable by removing instructions that compete with the central idea.",
			},
			{
				title: "Choose a practical output tier",
				description:
					"Basic 1K and High 2K are the current choices for this model. Use the editor's quote to review credits before committing to an iteration.",
			},
		],
		tip: "Define the focal point and spatial relationships first. Use a reference to guide a scene you want to develop further.",
		review:
			"Inspect complex compositions, small objects, and consistency with any supplied reference.",
	},
];

export function modelPath(key: ModelProductKey): string {
	return `/models/${key.slice("image-".length)}`;
}
export function modelPageForSlug(slug: string): ModelPageContent | undefined {
	return MODEL_PAGES.find((page) => page.key === `image-${slug}`);
}

function relatedModels(model: ModelPageContent): readonly ModelPageContent[] {
	return [
		...MODEL_PAGES.filter((candidate) => candidate.family === model.family),
		...MODEL_PAGES.filter((candidate) => candidate.family !== model.family),
	]
		.filter((candidate) => candidate.key !== model.key)
		.slice(0, 3);
}

export function modelRecommendations(model: ModelPageContent) {
	return relatedModels(model).map((candidate) => {
		// A destination owns its portraits; each referring page receives a different one.
		const referringPages = MODEL_PAGES.filter((page) =>
			relatedModels(page).some((related) => related.key === candidate.key),
		);
		const index = referringPages.findIndex((page) => page.key === model.key);
		const artwork = candidate.recommendationArtwork[index];
		if (!artwork) {
			throw new Error(`Missing recommendation artwork: ${model.key} → ${candidate.key}`);
		}
		return { model: candidate, artwork };
	});
}
