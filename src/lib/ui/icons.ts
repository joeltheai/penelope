export const ICONS = {
	pen: `<path d="M4.4 19.6 6.1 13.9 15.6 4.4a2.1 2.1 0 0 1 3 3L9.1 16.9l-4.7 2.7Z" />
		<path d="m13.1 6.9 3 3" />
		<path d="m6.6 13.9 3.5 3.5" />`,
	airbrush: `<path d="M8 9.5h6V20H8z" />
		<path d="M10 9.5V6.8h2v2.7" />
		<path d="M8 12.5h6" />
		<circle cx="18.2" cy="6.6" r="0.95" fill="currentColor" stroke="none" />
		<circle cx="20.4" cy="10" r="0.75" fill="currentColor" stroke="none" />
		<circle cx="18" cy="13.4" r="0.95" fill="currentColor" stroke="none" />
		<circle cx="20.8" cy="16.4" r="0.6" fill="currentColor" stroke="none" />`,
	lasso: `<path d="M19.4 9.8c0 2.7-3.3 4.9-7.4 4.9S4.6 12.5 4.6 9.8 7.9 5 12 5s7.4 2.1 7.4 4.8Z" />
		<path d="M9.5 14.2c.8 1 .7 2.1-.2 3.1-.7.8-1.7 1.2-2.6 1.1" />
		<path d="M8.2 18.5c.3.9-.1 1.7-.9 2.1" />`,
	fan: `<path d="M12 20.2v-7.1" />
		<path d="M12 13.1 6.4 7.3" />
		<path d="M12 13.1 17.6 7.3" />
		<path d="M12 13.1V3.8" />`,
	fanFade: `<path d="M12 20.2v-6.6" />
		<path d="M12 13.6 7.8 8.9" />
		<path d="M12 13.6V6.2" />
		<path d="M12 13.6 16.2 8.9" />
		<circle cx="6.7" cy="7.5" r="0.9" fill="currentColor" stroke="none" />
		<circle cx="12" cy="4.2" r="0.9" fill="currentColor" stroke="none" />
		<circle cx="17.3" cy="7.5" r="0.9" fill="currentColor" stroke="none" />`,
	eyedropper: `<path d="m2.6 21.4 1-1h2.9l8.6-8.6" />
		<path d="M3.6 20.4v-2.9l8.6-8.6" />
		<path d="m14.7 5.9 3.2-3.2a2 2 0 1 1 2.8 2.8l-3.2 3.2.4.4a2 2 0 1 1-2.8 2.8l-3.6-3.6a2 2 0 1 1 2.8-2.8l.4.4Z" />`,
	mirror: `<path d="M12 3v18" stroke-dasharray="2 3.2" />
		<path d="M8.4 7.4 4.2 12l4.2 4.6" />
		<path d="M15.6 7.4 19.8 12l-4.2 4.6" />`,
	undo: `<path d="M4 9.2h9.2a5 5 0 0 1 0 10H8.6" />
		<path d="m8 5.2-4 4 4 4" />`,
	redo: `<path d="M20 9.2h-9.2a5 5 0 0 0 0 10h4.6" />
		<path d="m16 5.2 4 4-4 4" />`,
	history: `<path d="M3.6 12a8.4 8.4 0 1 0 2.5-6" />
		<path d="M3.4 4.8v4.2h4.2" />
		<path d="M12 7.8v4.6l3 1.8" />`,
	canvas: `<path d="M4 8.4V4h4.4" />
		<path d="M20 8.4V4h-4.4" />
		<path d="M4 15.6V20h4.4" />
		<path d="M20 15.6V20h-4.4" />`,
	close: `<path d="m6.4 6.4 11.2 11.2" />
		<path d="M17.6 6.4 6.4 17.6" />`,
	chevronLeft: `<path d="m14.2 5.4-6.6 6.6 6.6 6.6" />`,
	chevronRight: `<path d="m9.8 5.4 6.6 6.6-6.6 6.6" />`,
	chevronUp: `<path d="m5.4 14.2 6.6-6.6 6.6 6.6" />`,
	chevronDown: `<path d="m5.4 9.8 6.6 6.6 6.6-6.6" />`
} as const;

export type IconName = keyof typeof ICONS;
