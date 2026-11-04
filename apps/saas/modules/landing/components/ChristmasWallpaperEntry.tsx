import { ArrowUpRightIcon, SnowflakeIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";

import { wallpaperImage } from "../../christmas/lib/wallpaper";

import "./christmas-entry.css";

export function ChristmasWallpaperEntry({
	copy,
}: {
	copy: {
		eyebrow: string;
		title: string;
		description: string;
		action: string;
		detail: string;
	};
}) {
	return (
		<section className="christmas-entry container" aria-labelledby="christmas-entry-title">
			<Link
				href="/christmas-wallpaper"
				className="christmas-entry-link"
				aria-labelledby="christmas-entry-title christmas-entry-action"
			>
				<div className="christmas-entry-copy">
					<span className="christmas-entry-eyebrow">
						<SnowflakeIcon aria-hidden="true" />
						{copy.eyebrow}
					</span>
					<h2 id="christmas-entry-title">{copy.title}</h2>
					<p>{copy.description}</p>
					<span id="christmas-entry-action" className="christmas-entry-action">
						{copy.action}
						<ArrowUpRightIcon aria-hidden="true" />
					</span>
					<span className="christmas-entry-detail">{copy.detail}</span>
				</div>
				<div className="christmas-entry-art" aria-hidden="true">
					{(["street", "fireplace", "pet"] as const).map((style) => (
						<div className={`christmas-entry-phone ${style}`} key={style}>
							<Image
								src={wallpaperImage(style)}
								width={941}
								height={1672}
								sizes="(max-width: 600px) 26vw, 170px"
								alt=""
							/>
							<span className="christmas-entry-clock">09:41</span>
						</div>
					))}
				</div>
			</Link>
		</section>
	);
}
