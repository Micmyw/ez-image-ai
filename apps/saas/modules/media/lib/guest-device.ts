const DATABASE_NAME = "ezpic-guest-device";
const STORE_NAME = "identity";
const DEVICE_KEY = "guest-device-id";

export async function getGuestDeviceId(): Promise<string> {
	if (typeof indexedDB === "undefined") return crypto.randomUUID();
	const database = await openDatabase();
	try {
		const existing = await readDeviceId(database);
		if (existing && isUuid(existing)) return existing;
		const deviceId = crypto.randomUUID();
		await writeDeviceId(database, deviceId);
		return deviceId;
	} finally {
		database.close();
	}
}

function openDatabase(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DATABASE_NAME, 1);
		request.onerror = () => reject(new Error("GUEST_DEVICE_UNAVAILABLE"));
		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains(STORE_NAME)) {
				request.result.createObjectStore(STORE_NAME);
			}
		};
		request.onsuccess = () => resolve(request.result);
	});
}

function readDeviceId(database: IDBDatabase): Promise<string | null> {
	return new Promise((resolve, reject) => {
		const request = database.transaction(STORE_NAME).objectStore(STORE_NAME).get(DEVICE_KEY);
		request.onerror = () => reject(new Error("GUEST_DEVICE_UNAVAILABLE"));
		request.onsuccess = () => resolve(typeof request.result === "string" ? request.result : null);
	});
}

function writeDeviceId(database: IDBDatabase, deviceId: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const transaction = database.transaction(STORE_NAME, "readwrite");
		transaction.onerror = () => reject(new Error("GUEST_DEVICE_UNAVAILABLE"));
		transaction.oncomplete = () => resolve();
		transaction.objectStore(STORE_NAME).put(deviceId, DEVICE_KEY);
	});
}

function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
