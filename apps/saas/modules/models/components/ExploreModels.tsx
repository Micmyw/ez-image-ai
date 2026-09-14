import Link from "next/link";

import { MODEL_PAGES, modelPath } from "../lib/model-pages";
import { ModelArtwork } from "./ModelArtwork";

const featured = ["image-gpt-image-2", "image-nano-banana-pro", "image-seedream-5-lite"];

export function ExploreModels() {
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
					className="text-sm text-violet-200 hover:text-white underline underline-offset-4"
				>
					Explore all 12 models <span aria-hidden="true">↗</span>
				</Link>
			</div>
			<div className="gap-6 md:grid-cols-3 grid">
				{featured
					.map((key) => MODEL_PAGES.find((model) => model.key === key)!)
					.map((model) => (
						<Link
							key={model.key}
							href={modelPath(model.key)}
							className="group min-w-0 focus-visible:outline-violet-300 block rounded-xl focus-visible:outline-2 focus-visible:outline-offset-4"
						>
							<div className="bg-white/5 overflow-hidden rounded-xl">
								<ModelArtwork
									artwork={model.artwork}
									sizes="(max-width: 768px) 90vw, 30vw"
									className="aspect-[4/3] w-full object-cover transition-transform duration-300 group-hover:scale-[1.025] motion-reduce:transition-none"
								/>
							</div>
							<div className="pt-5">
								<p className="text-xs text-violet-300">{model.tags[0]}</p>
								<h3 className="mt-2 text-xl font-semibold text-white">{model.name}</h3>
								<p className="mt-2 text-sm leading-6 text-[#b7acbf]">{model.lead}</p>
							</div>
						</Link>
					))}
			</div>
			<p className="mt-6 text-xs leading-6 text-[#a99db2]">
				Original EzPic concept artwork for inspiration. These images are not verified outputs from
				the named models.
			</p>
		</section>
	);
}
