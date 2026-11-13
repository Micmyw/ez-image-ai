// Real EzImageAI H3 outputs; Kie prompts and the original cafe reference retain their source receipts.
export const MINIMAX_H3_EXAMPLES = [
	{
		title: "Every texture, in its place",
		prompt:
			"Overhead knolling photograph on a warm light-gray linen tablecloth, shot in native 4K with every object tack-sharp. Exactly nine objects are arranged in a precise 3 by 3 grid with equal spacing, each one aligned square to the frame. Top row, left to right: a coiled brown leather camera strap, a small handheld light meter with a round analog dial, and a folded paper road map. Middle row, left to right: a red pocket notebook with a black elastic band, a silver-and-black vintage rangefinder camera exactly in the center of the image, and a chrome 50mm lens standing upright on its rear cap. Bottom row, left to right: three yellow 35mm film canisters standing side by side, a brass key on a round tan leather tag, and a pair of round tortoiseshell sunglasses folded closed. Soft, even daylight from the top left with short gentle shadows. Macro-level detail everywhere: the pebbled leather grain, the knurled metal rings and engraved distance scale on the lens, the paper fibers of the map and the weave of the linen are all crisp when zoomed in. No brand names, no logos, no emblems, no other text.",
		resolution: "1K",
		image: {
			src: "/images/models/minimax-h3/knolling-ezpic-1k.webp",
			width: 1024,
			height: 1024,
			sha256: "2a00a020d7319e2ea87add1e3ce95a045620d3472b18449049e2b2e9f482c93d",
			bytes: 516446,
			alt: "Camera equipment arranged in a three by three grid on a light linen cloth",
		},
	},
	{
		title: "Make the headline part of the image",
		prompt:
			'Square Swiss-style typographic poster for a fictional night ferry festival on cream textured paper. In the middle, a large flat-color illustration of a small white ferry crossing a dark navy river at night, its round portholes glowing warm yellow, with long golden reflections rippling on the water and a thin crescent moon above. At the top, a huge bold condensed sans-serif headline in vermilion red reads "LANTERN FERRY" on two stacked lines, tightly kerned. Below the illustration, a thin black rule, then a two-column grid of small black text: the left column reads "OCTOBER 3–5" with "PIER 7 · HARBOR DISTRICT" beneath it; the right column lists "BOARDING 7:30 PM", "LIVE STRINGS ON DECK" and "TICKETS AT THE DOCK". At the very bottom, a small centered line reads "THREE NIGHTS / ONE RIVER / A THOUSAND LIGHTS". Strict grid alignment, generous margins, flat print-ready colors limited to navy, vermilion, warm yellow, black and cream. Every word spelled exactly as written, sharp and legible. No people, no logos.',
		resolution: "1K",
		image: {
			src: "/images/models/minimax-h3/ferry-poster-ezpic-1k.webp",
			width: 1024,
			height: 1024,
			sha256: "ee74057f7cd176f0101cb6e78fe0c19e49de5128d8ccb61bd348f60751ed2d34",
			bytes: 141914,
			alt: "LANTERN FERRY festival poster in cream, navy, vermilion and gold",
		},
	},
	{
		title: "Explain an idea with an infographic",
		prompt:
			'A friendly editorial infographic in a warm hand-drawn gouache illustration style, horizontal layout on a cream background. Across the top, a bold rounded dark-brown title reads "THE PERFECT POUR-OVER". In the exact center, larger than everything else, a detailed illustration of a glass pour-over dripper with a paper filter sitting on a glass carafe, a thin spiral stream of water pouring from a gooseneck kettle above it and dark coffee dripping into the carafe. Around the central illustration, five numbered steps form a clockwise ring connected by a dotted arrow, starting at the upper left. Each step has a small round vignette and a short label beneath it: 1 "WEIGH 20 g BEANS" with a small kitchen scale; 2 "GRIND MEDIUM-FINE" with a wooden hand grinder; 3 "RINSE THE FILTER" with hot water over a paper filter; 4 "BLOOM FOR 30 s" with coffee grounds puffing up; 5 "POUR SLOWLY TO 320 g" with a spiral pour. Along the bottom, a slim info bar with three small icons and labels: "WATER 93 °C", "RATIO 1 : 16", "TOTAL 3:00". Muted palette of coffee brown, cream, sage green and terracotta, consistent line weight, generous spacing, every word and number exactly as written. No people, no logos.',
		resolution: "1K",
		image: {
			src: "/images/models/minimax-h3/pour-over-ezpic-1k.webp",
			width: 1248,
			height: 832,
			sha256: "6e378ad4abe023be24143c54dfa98a2e7a5a7b3a34f852acd595c165960e11d5",
			bytes: 133334,
			alt: "Hand-drawn pour-over coffee infographic with five numbered steps",
		},
	},
	{
		title: "From afternoon to a rainy evening",
		prompt:
			"Turn <Picture 1> into the same street at night just after rain. Keep the architecture, the café storefront, the tables and chairs, the olive trees, the street lamp, the balconies and the camera angle exactly the same. Make the sky a deep blue just after dusk, switch on warm golden light inside the café windows and in the street lamp, add a strand of small warm bulbs glowing along the edge of the awning, and light a few balcony windows above. Make the cobblestones and sidewalk wet, with glossy reflections of the warm lights and a few small puddles. Realistic night photography with natural light falloff and soft glow around the lights. No people, no cars.",
		resolution: "1K",
		image: {
			src: "/images/models/minimax-h3/cafe-night-ezpic-1k.webp",
			width: 1360,
			height: 768,
			sha256: "da184188619eaad7fd96c285aa7adeb701cd7f90f069cac1a1d77f0ebabc24f6",
			bytes: 249270,
			alt: "A cafe street after dusk with warm windows and reflections on wet cobblestones",
		},
		referenceImage: {
			src: "/images/models/minimax-h3/cafe-night-reference.webp",
			width: 1200,
			height: 678,
			sha256: "097f10210b7f6a880de11f22ccbc843552b550ccbc90e43c9b13beb225b45289",
			bytes: 230066,
			alt: "The original cafe street in daylight",
		},
	},
] as const;

// Original prompt; one live text-to-image submission, no reference image.
export const MINIMAX_H3_FEATURED_EXAMPLE = {
	title: "Somewhere beyond the clouds",
	resolution: "1K",
	prompt:
		"A breathtaking cinematic photograph of an impossible botanical sanctuary suspended above an endless sea of clouds at sunrise. One immense blue whale glides silently through the open sky beside a floating island, close enough to reveal pearlescent skin, delicate scars and water droplets catching the light. On the island, an elegant Victorian greenhouse of slender aged brass arches and crystal glass shelters lush emerald ferns, white orchids and a single luminous magnolia tree. A narrow waterfall pours from the island into the clouds. A tiny lone visitor in a flowing ivory coat stands on a curved stone balcony, giving the whale and architecture an overwhelming sense of scale. Strong, deliberate composition: the greenhouse on the left third, the whale sweeping across the upper right, an S-shaped cloud river guiding the eye into the distance. Warm amber sunlight refracts through the glass into subtle rainbow caustics; deep teal shadows, pale peach mist and soft ivory clouds. Monumental yet serene, extraordinary fine material detail, atmospheric depth, physically convincing light, restrained elegant color grading, large-format architectural photography, 35mm lens, crisp focal subjects with a gentle distant haze. No text, no logos, no borders.",
	image: {
		src: "/images/models/minimax-h3/cloud-sanctuary-ezpic-1k.webp",
		alt: "A blue whale gliding beside a floating glass conservatory above sunlit clouds",
		width: 1360,
		height: 768,
		sha256: "1c54d2a1a2b183e49e1ff690f89419fada467aaf4835a6c65987169d6e8ff9a5",
		bytes: 227398,
	},
} as const;
