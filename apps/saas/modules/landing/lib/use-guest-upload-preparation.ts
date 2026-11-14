"use client";

import { useEffect, useRef, useState } from "react";

import {
	prepareGuestDraftUpload,
	type GuestDraftUploadCheckpoint,
	type GuestUploadPreparationInput,
} from "./guest-draft-client";

interface PreparationSession {
	file: File;
	checkpoint: GuestDraftUploadCheckpoint | null;
	started: boolean;
	sealedReported: boolean;
	inFlight: Promise<GuestDraftUploadCheckpoint> | null;
}

/** Each selected File has one attempt, even while an older File resolves out of order. */
export function createGuestPreparationController(
	prepare: typeof prepareGuestDraftUpload = prepareGuestDraftUpload,
) {
	let current: PreparationSession | null = null;
	let preparationTail: Promise<void> | null = null;
	return {
		select(file: File | null) {
			if (current?.file === file) return current;
			current = file
				? { file, checkpoint: null, started: false, sealedReported: false, inFlight: null }
				: null;
			return current;
		},
		read: () => current,
		setCheckpoint(checkpoint: GuestDraftUploadCheckpoint, file: File) {
			if (current?.file === file) current.checkpoint = checkpoint;
		},
		ensure(
			input: Omit<GuestUploadPreparationInput, "checkpoint" | "onCheckpoint">,
			callbacks: {
				onChange?: () => void;
				onSealed?: (checkpoint: GuestDraftUploadCheckpoint) => void;
				onStart?: () => void;
			} = {},
		) {
			const session = current;
			if (!session || session.file !== input.file)
				return Promise.reject(new Error("GUEST_UPLOAD_REPLACED"));
			if (session.inFlight) return session.inFlight;
			session.started = true;
			const active = () => current === session;
			const previousPreparation = preparationTail;
			const begin = async () => {
				// Local previews can change immediately. The next server upload waits for
				// the older immutable attempt to finish sealing under the bounded upload limit.
				if (previousPreparation) await previousPreparation;
				if (!active()) throw new Error("GUEST_UPLOAD_REPLACED");
				return prepare({
					...input,
					checkpoint: session.checkpoint,
					onCheckpoint(checkpoint) {
						session.checkpoint = checkpoint;
						if (active()) callbacks.onChange?.();
					},
					onStage(stage) {
						if (!active()) return;
						if (stage === "uploading") callbacks.onStart?.();
						input.onStage?.(stage);
					},
					onProgress(progress) {
						if (active()) input.onProgress?.(progress);
					},
				});
			};
			const operation = begin()
				.then((checkpoint) => {
					if (!active()) throw new Error("GUEST_UPLOAD_REPLACED");
					if (!session.sealedReported) {
						session.sealedReported = true;
						callbacks.onSealed?.(checkpoint);
					}
					return checkpoint;
				})
				.finally(() => {
					session.inFlight = null;
					if (active()) callbacks.onChange?.();
				});
			session.inFlight = operation;
			preparationTail = operation.then(
				() => undefined,
				() => undefined,
			);
			callbacks.onChange?.();
			return operation;
		},
	};
}

export function useGuestUploadPreparation(input: {
	file: File | null;
	enabled: boolean;
	capabilityVersion?: string;
	productKey?: GuestUploadPreparationInput["productKey"];
	maximumBytes: number;
	journey?: GuestUploadPreparationInput["journey"];
	turnstileToken: string;
	consumeTurnstileToken: () => string;
	onUploadStarted?: () => void;
	onSealed?: (checkpoint: GuestDraftUploadCheckpoint) => void;
	onError?: (error: unknown) => void;
}) {
	const [revision, setRevision] = useState(0);
	const mounted = useRef(true);
	const controllerRef = useRef<ReturnType<typeof createGuestPreparationController> | null>(null);
	controllerRef.current ??= createGuestPreparationController();
	const controller = controllerRef.current;
	controller.select(input.file);
	const optionsRef = useRef(input);
	optionsRef.current = input;
	function ensurePrepared() {
		const options = optionsRef.current;
		const session = controller.read();
		if (!options.file || !options.capabilityVersion || !options.productKey || !options.enabled)
			return Promise.reject(new Error("GUEST_CAPABILITY_UNAVAILABLE"));
		if (session?.inFlight) return session.inFlight;
		const token = session?.checkpoint?.intent ? "" : options.consumeTurnstileToken();
		if (!session?.checkpoint?.intent && !token)
			return Promise.reject(new Error("GUEST_TURNSTILE_REQUIRED"));
		return controller.ensure(
			{
				file: options.file,
				capabilityVersion: options.capabilityVersion,
				productKey: options.productKey,
				maximumBytes: options.maximumBytes,
				turnstileToken: token,
				journey: options.journey,
			},
			{
				onChange: () => {
					if (mounted.current) setRevision((value) => value + 1);
				},
				onStart: () => {
					if (mounted.current) options.onUploadStarted?.();
				},
				onSealed: (checkpoint) => {
					if (mounted.current) options.onSealed?.(checkpoint);
				},
			},
		);
	}
	const ensureRef = useRef(ensurePrepared);
	ensureRef.current = ensurePrepared;
	useEffect(() => {
		const session = controller.read();
		if (
			!session ||
			session.started ||
			!input.enabled ||
			!input.capabilityVersion ||
			!input.productKey ||
			!input.turnstileToken
		)
			return;
		void ensureRef.current().catch((error) => {
			if (!mounted.current || controller.read() !== session) return;
			optionsRef.current.onError?.(error);
		});
	}, [
		controller,
		input.file,
		input.enabled,
		input.capabilityVersion,
		input.productKey,
		input.turnstileToken,
	]);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	return {
		checkpoint: controller.read()?.checkpoint ?? null,
		inFlight: Boolean(controller.read()?.inFlight),
		started: controller.read()?.started ?? false,
		ensurePrepared,
		setCheckpoint: (checkpoint: GuestDraftUploadCheckpoint, file: File) =>
			controller.setCheckpoint(checkpoint, file),
		// Read at the request boundary, not from a render captured before early preparation completed.
		getCheckpoint: () => controller.read()?.checkpoint ?? null,
		invalidate: () => controller.select(null),
		revision,
	};
}
