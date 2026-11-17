export const ICONS = {
	pen: `<path d="M15.4 3.2a2.4 2.4 0 0 1 3.4 3.4L9.7 15.7l-4.5 1.1 1.1-4.5L15.4 3.2Z" />
		<path d="m13.6 5 3.4 3.4" />`,
	airbrush: `<rect x="7" y="8" width="7.5" height="12.5" rx="1.5" />
		<path d="M9.2 8V5h3.2v3" />
		<path d="M9.2 11.2h3.2" />
		<circle cx="18" cy="6" r="1" fill="currentColor" stroke="none" />
		<circle cx="20.2" cy="9.6" r="0.8" fill="currentColor" stroke="none" />
		<circle cx="18" cy="13.2" r="1" fill="currentColor" stroke="none" />
		<circle cx="20.4" cy="16.6" r="0.7" fill="currentColor" stroke="none" />`,
	lasso: `<path d="M20 9.8c0 2.8-3.6 5-8 5s-8-2.2-8-5 3.6-5 8-5 8 2.2 8 5Z" />
		<path d="M8.4 14.4c.9 1.2.7 2.4-.3 3.4-.8.8-2 1.2-3 1.1" />
		<path d="M5.1 18.9c.5.9.2 1.9-.7 2.3" />`,
	fan: `<path d="M12 21v-5.5" />
		<path d="M3.8 15.5a8.6 8.6 0 0 1 16.4 0H3.8Z" />
		<path d="M12 15.5V6.6" />
		<path d="M12 15.5 7.6 7.6" />
		<path d="M12 15.5l4.4-7.9" />`,
	fanFade: `<path d="M12 21v-5.5" />
		<path d="M3.8 15.5a8.6 8.6 0 0 1 16.4 0H3.8Z" />
		<path d="M12 15.5V6.6" />
		<path d="M12 15.5 7.6 7.6" stroke-dasharray="2 2.4" />
		<path d="M12 15.5l4.4-7.9" stroke-dasharray="2 2.4" />
		<circle cx="3.8" cy="15.5" r="0.9" fill="currentColor" stroke="none" />
		<circle cx="20.2" cy="15.5" r="0.9" fill="currentColor" stroke="none" />`,
	eyedropper: `<path d="m2.6 21.4 1-1h2.9l8.6-8.6" />
		<path d="M3.6 20.4v-2.9l8.6-8.6" />
		<path d="m14.7 5.9 3.2-3.2a2 2 0 1 1 2.8 2.8l-3.2 3.2.4.4a2 2 0 1 1-2.8 2.8l-3.6-3.6a2 2 0 1 1 2.8-2.8l.4.4Z" />`,
	mirror: `<path d="M9.6 6.2 3.8 12l5.8 5.8V6.2Z" fill="currentColor" stroke="none" />
		<path d="M14.4 6.2 20.2 12l-5.8 5.8V6.2Z" />
		<path d="M12 2.8v18.4" stroke-dasharray="2 3" />`,
	undo: `<path d="M4 9.2h9.2a5 5 0 0 1 0 10H8.6" />
		<path d="m8 5.2-4 4 4 4" />`,
	redo: `<path d="M20 9.2h-9.2a5 5 0 0 0 0 10h4.6" />
		<path d="m16 5.2 4 4-4 4" />`,
	history: `<path d="M3.6 12a8.4 8.4 0 1 0 2.5-6" />
		<path d="M3.4 4.8v4.2h4.2" />
		<path d="M12 7.8v4.6l3 1.8" />`,
	canvas: `<path d="M4 8.5V4h4.5" />
		<path d="M20 8.5V4h-4.5" />
		<path d="M4 15.5V20h4.5" />
		<path d="M20 15.5V20h-4.5" />
		<rect x="9" y="9" width="6" height="6" opacity="0.55" />`,
	panel: `<rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
		<path d="M15 4.5v15" />`,
	close: `<path d="m6.4 6.4 11.2 11.2" />
		<path d="M17.6 6.4 6.4 17.6" />`,
	chevronLeft: `<path d="m14.2 5.4-6.6 6.6 6.6 6.6" />`,
	chevronRight: `<path d="m9.8 5.4 6.6 6.6-6.6 6.6" />`,
	chevronUp: `<path d="m5.4 14.2 6.6-6.6 6.6 6.6" />`,
	chevronDown: `<path d="m5.4 9.8 6.6 6.6 6.6-6.6" />`
} as const;

export type IconName = keyof typeof ICONS;
