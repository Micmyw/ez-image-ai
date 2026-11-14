import type { ComponentProps, ReactNode } from "react";

import { AnimatedModelCard } from "../../models/components/AnimatedModelCard";
import { ExamplePromptActions } from "./ExamplePromptActions";

import "./model-example-card.css";

type Example = ComponentProps<typeof ExamplePromptActions> & {
	id: string;
	category: string;
	description: string;
	animation?: string;
	selection: NonNullable<ComponentProps<typeof ExamplePromptActions>["selection"]>;
};

export function ModelExampleCard({
	example,
	featured = false,
	artwork,
}: {
	example: Example;
	featured?: boolean;
	artwork?: ReactNode;
}) {
	return (
		<article
			className="model-example-card"
			data-featured={featured || undefined}
			data-model-example={example.id}
		>
			{example.animation ? (
				<AnimatedModelCard
					href={`/ai-gif-generator?model=${example.selection.productKey}`}
					name={example.title}
					tag={example.category}
					lead={example.description}
					poster={example.image.src}
					animation={example.animation}
					alt={example.image.alt}
				/>
			) : (
				<>
					<div className="model-example-media">
						{artwork ?? (
							<img
								src={example.image.src}
								alt={example.image.alt}
								width={example.image.width}
								height={example.image.height}
								loading="lazy"
								decoding="async"
							/>
						)}
						<span>{example.resolution}</span>
					</div>
					<div className="model-example-caption">
						<div>
							<p className="model-example-category">{example.category}</p>
							<h3>{example.title}</h3>
							<p className="model-example-description">{example.description}</p>
						</div>
					</div>
				</>
			)}
			<ExamplePromptActions {...example} />
		</article>
	);
}
