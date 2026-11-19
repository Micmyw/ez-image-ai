"use client";

import dynamic from "next/dynamic";

export const LazyPortraitPackInvitation = dynamic(() =>
	import("./PortraitPackInvitation").then((module) => module.PortraitPackInvitation),
);
