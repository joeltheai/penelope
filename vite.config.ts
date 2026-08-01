import tailwindcss from '@tailwindcss/vite';
import cloudflare from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

/**
 * Keep Cloudflare for `vite build` / CI deploy, but skip `emulate()` so
 * `vite dev` does not start Wrangler/workerd (and its local SQLite state).
 */
function adapter() {
	const { emulate: _emulate, ...rest } = cloudflare();
	return rest;
}

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter()
		})
	]
});
