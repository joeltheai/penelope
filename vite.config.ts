import tailwindcss from '@tailwindcss/vite';
import cloudflare from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import typegpu from 'unplugin-typegpu/vite';
import { defineConfig } from 'vite';

function adapter() {
	const { emulate: _emulate, ...rest } = cloudflare();
	return rest;
}

export default defineConfig({
	plugins: [
		typegpu(),
		basicSsl(),
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter()
		})
	],
	server: {
		host: true
	}
});
