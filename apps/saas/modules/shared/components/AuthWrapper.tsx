import { config } from "@config";
import { cn, Logo } from "@repo/ui";
import { ImagePlusIcon, LockKeyholeIcon, SparklesIcon } from "lucide-react";
import type { PropsWithChildren } from "react";

import { ColorModeToggle } from "./ColorModeToggle";
import { Footer } from "./Footer";

export function AuthWrapper({
	children,
	contentClass,
	variant = "default",
	productCopy,
}: PropsWithChildren<{
	contentClass?: string;
	variant?: "default" | "product";
	productCopy?: {
		eyebrow: string;
		title: string;
		description: string;
		sequence: string;
		privateLabel: string;
	};
}>) {
	if (variant === "product") {
		return (
			<div
				data-auth-shell="product"
				className="ezpic-auth-shell relative min-h-screen overflow-hidden bg-[#120d1a] text-[#f6f2fb]"
			>
				<div
					className="inset-0 pointer-events-none absolute bg-[radial-gradient(circle_at_12%_16%,rgba(108,77,255,0.24),transparent_30rem),radial-gradient(circle_at_88%_84%,rgba(253,186,116,0.11),transparent_28rem),linear-gradient(135deg,#120d1a_0%,#171020_54%,#0f0b16_100%)]"
					aria-hidden="true"
				/>
				<div
					className="top-0 pointer-events-none absolute inset-x-[12%] h-px bg-gradient-to-r from-transparent via-[#b79cff]/55 to-transparent"
					aria-hidden="true"
				/>

				<div className="relative z-10 flex min-h-screen flex-col">
					<header className="min-h-20 container flex items-center">
						<a
							href="/"
							aria-label={config.appName}
							className="text-white rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-[#b79cff] focus-visible:ring-offset-4 focus-visible:ring-offset-[#120d1a]"
						>
							<Logo className="text-white [&_svg]:text-[#b79cff]" label={config.appName} />
						</a>
					</header>

					<div className="py-8 sm:py-10 lg:py-12 container flex flex-1 items-center">
						<div className="gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(26rem,29rem)] lg:gap-16 xl:gap-24 mx-auto grid w-full max-w-[76rem] items-center">
							<section className="lg:block hidden" aria-hidden="true">
								<div className="max-w-xl">
									<div className="gap-2 text-xs font-bold flex items-center tracking-[0.18em] text-[#b79cff] uppercase">
										<SparklesIcon className="size-4" />
										<span>{productCopy?.eyebrow}</span>
									</div>
									<p className="mt-4 max-w-xl text-4xl font-semibold text-white xl:text-5xl leading-[1.06] tracking-[-0.045em] text-balance">
										{productCopy?.title}
									</p>
									<p className="mt-4 max-w-lg text-base leading-7 text-[#b7acbf]">
										{productCopy?.description}
									</p>
								</div>

								<div className="mt-9 border-white/10 p-3 backdrop-blur-xl overflow-hidden rounded-[2rem] border bg-[#241a31]/88 shadow-[0_38px_110px_-52px_rgba(108,77,255,0.95),inset_0_1px_0_rgba(255,255,255,0.07)]">
									<div className="px-2 py-2 flex items-center justify-between">
										<div className="gap-1.5 flex">
											<span className="size-2 bg-white/25 rounded-full" />
											<span className="size-2 bg-white/15 rounded-full" />
											<span className="size-2 bg-white/10 rounded-full" />
										</div>
										<span className="px-3 py-1 font-mono rounded-full border border-[#b79cff]/20 bg-[#b79cff]/10 text-[0.65rem] tracking-[0.12em] text-[#d7ccff] uppercase">
											{productCopy?.sequence}
										</span>
									</div>

									<div className="gap-2 bg-black/15 p-2 grid grid-cols-[8.5rem_minmax(0,1fr)] rounded-[1.4rem]">
										<div className="min-h-48 border-white/20 bg-white/[0.025] relative flex items-center justify-center overflow-hidden rounded-[1rem] border border-dashed">
											<div className="-left-8 top-10 size-24 blur-2xl absolute rounded-full bg-[#6c4dff]/25" />
											<span className="size-12 shadow-lg grid place-items-center rounded-2xl border border-[#b79cff]/20 bg-[#b79cff]/10 text-[#c9b9ff]">
												<ImagePlusIcon className="size-5" />
											</span>
										</div>

										<div className="min-w-0 border-white/[0.08] bg-black/10 p-4 flex flex-col rounded-[1rem] border">
											<div className="h-2.5 w-20 bg-white/15 rounded-full" />
											<div className="mt-4 space-y-2.5">
												<div className="h-2 bg-white/10 rounded-full" />
												<div className="h-2 bg-white/[0.07] w-[84%] rounded-full" />
												<div className="h-2 bg-white/[0.06] w-[62%] rounded-full" />
											</div>
											<div className="gap-3 pt-6 mt-auto flex items-end">
												<div className="h-16 border-white/10 relative flex-1 overflow-hidden rounded-xl border bg-[linear-gradient(135deg,#2e2240,#181020)]">
													<div className="inset-y-0 bg-white/70 absolute left-1/2 w-px shadow-[0_0_18px_rgba(255,255,255,0.45)]" />
													<div className="-bottom-7 -left-3 size-20 absolute rounded-full bg-[#7c5cff]/35" />
													<div className="-right-5 -top-8 size-24 absolute rounded-full bg-[#fdba74]/25" />
												</div>
												<span className="h-11 w-11 rounded-full bg-[#6c4dff] shadow-[0_12px_28px_-10px_rgba(108,77,255,0.95)]" />
											</div>
										</div>
									</div>

									<div className="gap-2 px-3 pb-2 pt-3 text-xs flex items-center text-[#a99db2]">
										<LockKeyholeIcon className="size-3.5 text-emerald-300" />
										<span>{productCopy?.privateLabel}</span>
									</div>
								</div>
							</section>

							<main className={cn("mx-auto w-full max-w-[29rem]", contentClass)}>
								<div className="border-white/10 p-6 backdrop-blur-2xl sm:p-8 relative overflow-hidden rounded-[2rem] border bg-[#21182c]/96 shadow-[0_36px_110px_-36px_rgba(0,0,0,0.92),0_24px_65px_-42px_rgba(183,156,255,0.78),inset_0_1px_0_rgba(255,255,255,0.08)]">
									<div
										className="inset-x-16 top-0 pointer-events-none absolute h-px bg-gradient-to-r from-transparent via-[#c9b9ff]/75 to-transparent"
										aria-hidden="true"
									/>
									{children}
								</div>
							</main>
						</div>
					</div>

					<Footer />
				</div>
			</div>
		);
	}

	return (
		<div className="py-6 flex min-h-screen w-full">
			<div className="gap-8 flex w-full flex-col items-center justify-between">
				<div className="container">
					<div className="flex items-center justify-between">
						<a href="/" className="block">
							<Logo label={config.appName} />
						</a>

						<div className="gap-2 flex items-center justify-end">
							<ColorModeToggle />
						</div>
					</div>
				</div>

				<div className="container flex justify-center">
					<main className={cn("max-w-md w-full", contentClass)}>{children}</main>
				</div>

				<Footer />
			</div>
		</div>
	);
}
