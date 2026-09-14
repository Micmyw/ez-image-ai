import type { EZPIC_PRODUCT_KEYS } from "@repo/config/client";

export type ModelProductKey = (typeof EZPIC_PRODUCT_KEYS)[number];
export type InspirationKey =
	| "gpt-poster"
	| "nano-product"
	| "nano-portrait"
	| "gpt-campaign"
	| "seedream-cinema"
	| "seedream-interior";

export const INSPIRATION = {
	"gpt-poster": {
		title: "Make words part of the picture",
		alt: "Slow Days travel poster with a cobalt arch and turquoise Mediterranean sea",
		prompt:
			'Design a contemporary travel poster. A cobalt-blue architectural arch frames a white sailboat on a turquoise sea. Add a coral sun, warm paper texture, and geometric shadows. Set the exact headline "SLOW DAYS" in large cream condensed lettering and "BY THE SEA" at the bottom. Keep the composition uncluttered.',
	},
	"nano-product": {
		title: "A product, a material, a mood",
		alt: "Silver headphones with green cushions on translucent lime acrylic blocks",
		prompt:
			"Photograph unbranded silver over-ear headphones with forest-green cushions on translucent lime acrylic blocks. Use a pistachio backdrop, one diagonal shaft of sunlight, precise metal reflections, and tactile fabric. Leave breathing room around the product. No text or logos.",
	},
	"nano-portrait": {
		title: "A character with a point of view",
		alt: "Fictional woman in a cobalt coat and orange scarf on a Paris street after rain",
		prompt:
			"Create a candid editorial portrait of a fictional adult woman with a short dark bob, cobalt-blue wool coat, and burnt-orange scarf on a quiet Paris street after rain. She looks back over her shoulder. Use natural skin texture, soft daylight, warm cafe lights, and subtle film grain. No logos.",
	},
	"gpt-campaign": {
		title: "Give a campaign a visual language",
		alt: "Amber serum bottle, blood orange, and green leaf in warm sunlight",
		prompt:
			"Create a botanical skincare campaign: an unbranded frosted amber serum bottle with an ivory cap on warm travertine, one curved green leaf, and a cut blood orange. Show tiny droplets and caustics on terracotta plaster. Use late-afternoon sunlight, realistic glass, and an asymmetric composition. No lettering.",
	},
	"seedream-cinema": {
		title: "Tell a story with light and scale",
		alt: "Tiny traveler in a red coat above a misty fjord and dark mountains",
		prompt:
			"Create a cinematic establishing shot of a lone traveler in a red coat on a stone path above a mist-filled fjord. Towering basalt mountains, small waterfalls, a pale crescent moon, and a shaft of golden dawn light on the water. Keep the person tiny against the landscape. Cool blue-gray atmosphere, textured rock, and volumetric fog. No text.",
	},
	"seedream-interior": {
		title: "Build an atmosphere you can feel",
		alt: "Sculptural living room with a curved linen sofa and circular coastal window",
		prompt:
			"Create an architectural editorial photograph of a serene living room: a curved oatmeal linen sofa, low walnut table, olive tree, burnt-orange vase, and large circular window overlooking the coast. Honey-colored plaster, warm afternoon sunlight, soft curved shadows, and natural material textures. Realistic proportions. No people or text.",
	},
} as const;

export interface ModelPageContent {
	key: ModelProductKey;
	name: string;
	family: "GPT Image" | "Nano Banana" | "Seedream";
	lead: string;
	description: string;
	tags: readonly string[];
	artwork: InspirationKey;
	features: readonly { title: string; description: string }[];
	tip: string;
	review: string;
}

export const MODEL_PAGES: readonly ModelPageContent[] = [
	{
		key: "image-gpt-image-2",
		name: "GPT Image 2",
		family: "GPT Image",
		lead: "Your brief. Down to the last detail.",
		description:
			"Turn carefully written prompts into posters, product visuals, and richly composed scenes. Bring the subject, layout, and lettering into one creative brief.",
		tags: ["Detailed prompts", "Poster design", "Product visuals"],
		artwork: "gpt-poster",
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
		name: "GPT Image 2.5 Flare",
		family: "GPT Image",
		lead: "Everyday ideas, with a little more atmosphere.",
		description:
			"Explore portraits, lifestyle imagery, and everyday creative concepts with a focus on natural detail and a clear visual brief.",
		tags: ["Everyday creativity", "Natural detail", "Portrait concepts"],
		artwork: "nano-portrait",
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
		name: "GPT Image 2.5 Sunburst",
		family: "GPT Image",
		lead: "Give your next campaign a clear direction.",
		description:
			"Develop art-directed product scenes, editorial concepts, and campaign visuals with deliberate composition, color, and material choices.",
		tags: ["Campaign concepts", "Art direction", "Material detail"],
		artwork: "gpt-campaign",
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
		name: "GPT Image 1.5",
		family: "GPT Image",
		lead: "From a clear instruction to a considered image.",
		description:
			"Explore image concepts and reference-based changes with explicit instructions and a choice of Medium or High quality.",
		tags: ["Instruction-led creation", "Medium / High", "Graphic concepts"],
		artwork: "gpt-poster",
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
		name: "Nano Banana 2 Lite",
		family: "Nano Banana",
		lead: "A focused starting point for your next idea.",
		description:
			"Explore social visuals, character concepts, and everyday image ideas with a straightforward 1K output setting.",
		tags: ["1K output", "Social concepts", "Everyday ideas"],
		artwork: "nano-portrait",
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
		name: "Nano Banana",
		family: "Nano Banana",
		lead: "One idea. Plenty of creative directions.",
		description:
			"Explore portraits, stylized artwork, and product concepts with natural-language prompts and optional reference images.",
		tags: ["Portraits", "Style exploration", "Reference edits"],
		artwork: "nano-portrait",
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
		name: "Nano Banana 2",
		family: "Nano Banana",
		lead: "Explore a look. Then develop the details.",
		description:
			"Shape portrait, product, and visual storytelling ideas with reference guidance and a choice of 1K, 2K, or 4K output.",
		tags: ["1K / 2K / 4K", "Visual storytelling", "Style control"],
		artwork: "nano-portrait",
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
		name: "Nano Banana Pro",
		family: "Nano Banana",
		lead: "Make the material part of the story.",
		description:
			"Explore polished product scenes, editorial still life, and detailed visual concepts with 1K, 2K, and 4K output options.",
		tags: ["Product photography", "Material studies", "1K / 2K / 4K"],
		artwork: "nano-product",
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
		name: "Seedream 4.0",
		family: "Seedream",
		lead: "Find the color and shape of an idea.",
		description:
			"Explore atmospheric scenes, illustration directions, and spatial concepts with flexible output sizes and a focused visual brief.",
		tags: ["Scene design", "Color exploration", "1K / 2K / 4K"],
		artwork: "seedream-interior",
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
		name: "Seedream 4.5",
		family: "Seedream",
		lead: "Create a scene with room to breathe.",
		description:
			"Develop interiors, lifestyle scenes, and richly textured image concepts with Basic 2K and High 4K output choices.",
		tags: ["Interior concepts", "Natural texture", "2K / 4K"],
		artwork: "seedream-interior",
		features: [
			{
				title: "Shape the atmosphere",
				description:
					"Describe the light, the materials, and the sense of space. Warm plaster, linen, wood, and soft shadows can establish a very different direction from glass and cool evening light.",
			},
			{
				title: "Give the composition depth",
				description:
					"Name the foreground, the main subject, and what lies beyond it. These relationships help turn a collection of objects into a readable scene.",
			},
			{
				title: "Choose between two output tiers",
				description:
					"The editor pairs Basic with 2K and High with 4K for this model. Review the selected tier and its credits before generating.",
			},
		],
		tip: "Describe the camera position and the direction of daylight before listing furnishings or decorative details.",
		review:
			"Review perspective, repeated textures, and the geometry of windows, furniture, and hands.",
	},
	{
		key: "image-seedream-5-lite",
		name: "Seedream 5 Lite",
		family: "Seedream",
		lead: "Let the light tell the story.",
		description:
			"Explore cinematic landscapes, dramatic lighting, and atmospheric scenes with Basic 2K, High 3K, and Ultra 4K choices.",
		tags: ["Cinematic mood", "Dramatic light", "2K / 3K / 4K"],
		artwork: "seedream-cinema",
		features: [
			{
				title: "Compose a cinematic moment",
				description:
					"Choose a viewpoint, a sense of scale, and a clear focal point. A small figure in a large landscape can communicate a story without adding more objects.",
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
			"Check distant structures, repeated figures, and whether the visual focal point matches the intended story.",
	},
	{
		key: "image-seedream-5-pro",
		name: "Seedream 5 Pro",
		family: "Seedream",
		lead: "A deliberate frame for a bigger idea.",
		description:
			"Develop composed campaign scenes, architectural concepts, and visual narratives with Basic 1K or High 2K output.",
		tags: ["Composed scenes", "Campaign imagery", "1K / 2K"],
		artwork: "seedream-cinema",
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
