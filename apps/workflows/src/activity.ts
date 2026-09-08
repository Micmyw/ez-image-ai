/** Coordinates async idle checks with new Container request admission. */
export class ContainerActivity {
	private active = 0;
	private stopping = false;

	enter(): boolean {
		if (this.stopping) return false;
		this.active++;
		return true;
	}
	leave(): void {
		this.active--;
	}

	async stopIfIdle(
		readNodeActive: () => Promise<number>,
		stop: () => Promise<void>,
	): Promise<boolean> {
		if (this.stopping || this.active > 0) return false;
		this.stopping = true;
		try {
			if ((await readNodeActive()) !== 0) return false;
			await stop();
			return true;
		} finally {
			this.stopping = false;
		}
	}
}
