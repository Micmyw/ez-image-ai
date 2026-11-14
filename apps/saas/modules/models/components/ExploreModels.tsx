import Link from "next/link";

import { ModelExampleCard } from "../../image-tools/components/ModelExampleCard";
import { GPT_IMAGE_2_6_EXAMPLES } from "../../image-tools/lib/gpt-image-2-6-examples";
import { MINIMAX_H3_FEATURED_EXAMPLE } from "../../image-tools/lib/minimax-h3-examples";
import { SEEDREAM_5_5_EXAMPLES } from "../../image-tools/lib/seedream-5-5-examples";
import { LandingArtwork } from "../../landing/components/LandingArtwork";
import { INSPIRATION } from "../lib/model-artwork";
import { MODEL_PAGES, modelPath } from "../lib/model-pages";
import { AnimatedModelCard } from "./AnimatedModelCard";

const citrusPool = GPT_IMAGE_2_6_EXAMPLES.sunburst.find((example) => example.id === "citrus-pool")!;

const featured = [
	{
		href: "/seedream-5-5",
		name: "Seedream 5.5",
		tag: "Photorealism & precise edits",
		lead: "Bring texture, light and detail into focus.",
		image: SEEDREAM_5_5_EXAMPLES[1].image,
	},
	{
		href: "/minimax-h3-image",
		name: "MiniMax H3 Image",
		tag: "Imaginative scenes",
		lead: "Give your imagination room to grow.",
		image: MINIMAX_H3_FEATURED_EXAMPLE.image,
	},
	{
		href: "/gpt-image-2-6-sunburst",
		name: "GPT Image 2.6 Sunburst",
		tag: "Animated GIFs",
		lead: "From one prompt to a looping animation.",
		image: {
			src: "/images/models/gpt-image-2-6/origami-hummingbird.webp",
			alt: "Iridescent origami hummingbird flapping its wings on a violet background",
		},
	},
	...["image-gpt-image-2", "image-nano-banana-pro", "image-seedream-5-lite"].map((key) => {
		const model = MODEL_PAGES.find((model) => model.key === key)!;
		return {
			href: modelPath(model.key),
			name: model.name,
			tag: model.tags[0],
			lead: model.lead,
			image: {
				src: `/images/models/${model.exampleArtwork}.webp`,
				alt: INSPIRATION[model.exampleArtwork].alt,
			},
		};
	}),
];

export function ExploreModels({ showFeaturedExample = false }: { showFeaturedExample?: boolean }) {
	return (
		<section
			id="models"
			className="py-14 sm:py-20 container"
			aria-labelledby="explore-models-title"
		>
			<div className="mb-8 gap-5 flex flex-wrap items-end justify-between">
				<div>
					<p className="mb-3 text-xs font-semibold tracking-widest text-violet-300 uppercase">
						Find your creative direction
					</p>
					<h2
						id="explore-models-title"
						className="text-3xl font-semibold tracking-tight text-white sm:text-4xl"
					>
						One workspace. Different possibilities.
					</h2>
				</div>
				<Link
					href="/models"
					prefetch={false}
					className="text-sm text-violet-200 hover:text-white underline underline-offset-4"
				>
					Explore image models <span aria-hidden="true">↗</span>
				</Link>
			</div>
			{showFeaturedExample && (
				<ModelExampleCard
					example={{ ...citrusPool, category: citrusPool.model }}
					featured
					artwork={
						<LandingArtwork
							src={citrusPool.image.src}
							alt={citrusPool.image.alt}
							sizes="(min-width: 1280px) 1248px, calc(100vw - 32px)"
						/>
					}
				/>
			)}
			<div className="gap-x-6 gap-y-10 md:grid-cols-3 grid">
				{featured.map((model) =>
					model.href === "/gpt-image-2-6-sunburst" ? (
						<AnimatedModelCard
							key={model.href}
							href={model.href}
							name={model.name}
							tag={model.tag}
							lead={model.lead}
							poster={model.image.src}
							animation="/images/models/gpt-image-2-6/origami-hummingbird.gif"
							alt={model.image.alt}
						/>
					) : (
						<Link
							key={model.href}
							href={model.href}
							prefetch={false}
							className="group min-w-0 focus-visible:outline-violet-300 block rounded-xl focus-visible:outline-2 focus-visible:outline-offset-4"
						>
							<div className="bg-white/5 aspect-[3/2] overflow-hidden rounded-xl">
								<LandingArtwork
									src={model.image.src}
									alt={model.image.alt}
									sizes="(min-width: 1280px) 380px, (min-width: 768px) 30vw, calc(100vw - 32px)"
									desktopPreload={model.href === "/minimax-h3-image"}
									className="h-full w-full object-cover"
								/>
							</div>
							<div className="pt-5">
								<p className="text-xs text-violet-300">{model.tag}</p>
								<h3 className="mt-2 text-xl font-semibold text-white">{model.name}</h3>
								<p className="mt-2 text-sm leading-6 text-[#b7acbf]">{model.lead}</p>
							</div>
						</Link>
					),
				)}
			</div>
		</section>
	);
}
