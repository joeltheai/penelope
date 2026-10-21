/// <reference types="vite/client" />

declare global {
	namespace App {
		interface Platform {
			env: Env;
			ctx: ExecutionContext;
			caches: CacheStorage;
			cf?: IncomingRequestCfProperties;
		}
	}

	interface EyeDropper {
		open(options?: { signal?: AbortSignal }): Promise<{ sRGBHex: string }>;
	}

	interface EyeDropperConstructor {
		new (): EyeDropper;
	}

	interface Window {
		EyeDropper?: EyeDropperConstructor;
	}
}

export {};
