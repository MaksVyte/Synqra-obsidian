import { Annotation, EditorSelection, type Extension } from '@codemirror/state';
import { EditorView, layer, type LayerMarker, RectangleMarker, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import * as Y from 'yjs';
import type * as awarenessProtocol from 'y-protocols/awareness';

const remoteCursorsAnnotation = Annotation.define<number[]>();

interface AwarenessUserState {
	cursor?: {
		anchor?: Y.RelativePosition;
		head?: Y.RelativePosition;
	} | null;
	user?: {
		name?: string;
		color?: string;
		colorLight?: string;
	};
}

class RemoteSelectionMarker implements LayerMarker {
	constructor(
		readonly top: number,
		readonly left: number,
		readonly width: number,
		readonly height: number,
		readonly colorLight: string,
		readonly clientId: number,
	) {}

	draw(): HTMLElement {
		const elt = createDiv({ cls: 'cm-remote-selection-box' });
		elt.style.setProperty('top', `${this.top}px`);
		elt.style.setProperty('left', `${this.left}px`);
		elt.style.setProperty('width', `${this.width}px`);
		elt.style.setProperty('height', `${this.height}px`);
		elt.style.setProperty('background-color', this.colorLight);
		return elt;
	}

	update(dom: HTMLElement, prev: LayerMarker): boolean {
		if (prev instanceof RemoteSelectionMarker && prev.colorLight === this.colorLight) {
			dom.style.setProperty('top', `${this.top}px`);
			dom.style.setProperty('left', `${this.left}px`);
			dom.style.setProperty('width', `${this.width}px`);
			dom.style.setProperty('height', `${this.height}px`);
			return true;
		}
		return false;
	}

	eq(other: LayerMarker): boolean {
		return (
			other instanceof RemoteSelectionMarker &&
			other.top === this.top &&
			other.left === this.left &&
			other.width === this.width &&
			other.height === this.height &&
			other.colorLight === this.colorLight &&
			other.clientId === this.clientId
		);
	}
}

class RemoteCursorMarker implements LayerMarker {
	constructor(
		readonly top: number,
		readonly left: number,
		readonly height: number,
		readonly color: string,
		readonly name: string,
		readonly clientId: number,
	) {}

	draw(): HTMLElement {
		const container = createDiv({ cls: 'cm-remote-cursor-container' });
		container.style.setProperty('top', `${this.top}px`);
		container.style.setProperty('left', `${this.left}px`);
		container.style.setProperty('height', `${this.height}px`);

		const caret = container.createDiv({ cls: 'cm-remote-cursor-caret' });
		caret.style.setProperty('background-color', this.color);
		caret.style.setProperty('box-shadow', `0 0 4px ${this.color}88`);

		const label = container.createDiv({
			cls: 'cm-remote-cursor-label',
			text: this.name,
		});
		label.style.setProperty('background-color', this.color);

		return container;
	}

	update(dom: HTMLElement, prev: LayerMarker): boolean {
		if (
			prev instanceof RemoteCursorMarker &&
			prev.color === this.color &&
			prev.name === this.name
		) {
			dom.style.setProperty('top', `${this.top}px`);
			dom.style.setProperty('left', `${this.left}px`);
			dom.style.setProperty('height', `${this.height}px`);
			return true;
		}
		return false;
	}

	eq(other: LayerMarker): boolean {
		return (
			other instanceof RemoteCursorMarker &&
			other.top === this.top &&
			other.left === this.left &&
			other.height === this.height &&
			other.color === this.color &&
			other.name === this.name &&
			other.clientId === this.clientId
		);
	}
}

export function createRemoteCursorPlugin(
	ytext: Y.Text,
	awareness: awarenessProtocol.Awareness,
): Extension {
	const awarenessTracker = ViewPlugin.fromClass(
		class {
			private readonly listener: (changes: { added: number[]; updated: number[]; removed: number[] }) => void;

			constructor(readonly view: EditorView) {
				this.listener = ({ added, updated, removed }) => {
					const clients = added.concat(updated, removed);
					if (clients.some((id) => id !== awareness.doc.clientID)) {
						view.dispatch({ annotations: [remoteCursorsAnnotation.of(clients)] });
					}
				};
				awareness.on('change', this.listener);
			}

			destroy(): void {
				awareness.off('change', this.listener);
			}

			update(update: ViewUpdate): void {
				const localState = awareness.getLocalState() as AwarenessUserState | null;
				if (localState != null) {
					const hasFocus = update.view.hasFocus;
					const sel = hasFocus ? update.state.selection.main : null;
					const cursor = localState.cursor;
					const currentAnchor = cursor?.anchor != null ? Y.createRelativePositionFromJSON(cursor.anchor) : null;
					const currentHead = cursor?.head != null ? Y.createRelativePositionFromJSON(cursor.head) : null;

					if (sel != null) {
						const anchor = Y.createRelativePositionFromTypeIndex(ytext, sel.anchor);
						const head = Y.createRelativePositionFromTypeIndex(ytext, sel.head);
						if (
							cursor == null ||
							!Y.compareRelativePositions(currentAnchor, anchor) ||
							!Y.compareRelativePositions(currentHead, head)
						) {
							awareness.setLocalStateField('cursor', { anchor, head });
						}
					} else if (cursor != null && !hasFocus) {
						awareness.setLocalStateField('cursor', null);
					}
				}
			}
		},
	);

	const clickHandler = EditorView.domEventHandlers({
		pointerdown(_e, view) {
			window.setTimeout(() => {
				if (view.dom && view.dom.isConnected && view.hasFocus) {
					const localState = awareness.getLocalState() as AwarenessUserState | null;
					if (localState) {
						const sel = view.state.selection.main;
						const anchor = Y.createRelativePositionFromTypeIndex(ytext, sel.anchor);
						const head = Y.createRelativePositionFromTypeIndex(ytext, sel.head);
						awareness.setLocalStateField('cursor', { anchor, head });
					}
				}
			}, 10);
			return false;
		},
	});

	const selectionLayer = layer({
		above: false, // Render selection highlights behind text in floating overlay
		update(_update: ViewUpdate) {
			return true;
		},
		markers(view: EditorView): readonly LayerMarker[] {
			const ydoc = ytext.doc;
			if (!ydoc) return [];

			const markers: LayerMarker[] = [];
			const docLength = view.state.doc.length;

			awareness.getStates().forEach((rawState, clientId) => {
				if (clientId === awareness.doc.clientID) return;
				const state = rawState as AwarenessUserState;
				const cursor = state?.cursor;
				if (!cursor || !cursor.anchor || !cursor.head) return;

				const anchorPos = Y.createAbsolutePositionFromRelativePosition(cursor.anchor, ydoc);
				const headPos = Y.createAbsolutePositionFromRelativePosition(cursor.head, ydoc);
				if (!anchorPos || !headPos || anchorPos.type !== ytext || headPos.type !== ytext) return;

				const from = Math.max(0, Math.min(anchorPos.index, docLength));
				const to = Math.max(0, Math.min(headPos.index, docLength));
				if (from === to) return;

				const start = Math.min(from, to);
				const end = Math.max(from, to);
				const range = EditorSelection.range(start, end);

				const { color = '#30bced' } = state.user || {};
				const colorLight = state.user?.colorLight || color + '33';

				const rectMarkers = RectangleMarker.forRange(view, 'cm-remote-selection-box', range);
				for (const rm of rectMarkers) {
					markers.push(
						new RemoteSelectionMarker(
							rm.top,
							rm.left,
							rm.width ?? 0,
							rm.height,
							colorLight,
							clientId,
						),
					);
				}
			});

			return markers;
		},
	});

	const cursorLayer = layer({
		above: true, // Render cursor carets and name tags above text in floating overlay
		update(_update: ViewUpdate) {
			return true;
		},
		markers(view: EditorView): readonly LayerMarker[] {
			const ydoc = ytext.doc;
			if (!ydoc) return [];

			const markers: LayerMarker[] = [];
			const docLength = view.state.doc.length;

			awareness.getStates().forEach((rawState, clientId) => {
				if (clientId === awareness.doc.clientID) return;
				const state = rawState as AwarenessUserState;
				const cursor = state?.cursor;
				if (!cursor || !cursor.head) return;

				const headPos = Y.createAbsolutePositionFromRelativePosition(cursor.head, ydoc);
				if (!headPos || headPos.type !== ytext) return;

				const pos = Math.max(0, Math.min(headPos.index, docLength));
				const coords = view.coordsAtPos(pos);
				if (!coords) return;

				// Convert viewport coordinates to document-relative layer coordinates
				const docRect = view.scrollDOM.getBoundingClientRect();
				const left = coords.left - docRect.left + view.scrollDOM.scrollLeft;
				const top = coords.top - docRect.top + view.scrollDOM.scrollTop;
				const height = coords.bottom - coords.top || 18;

				const { color = '#30bced', name = 'Anonymous' } = state.user || {};

				markers.push(new RemoteCursorMarker(top, left, height, color, name, clientId));
			});

			return markers;
		},
	});

	return [awarenessTracker, clickHandler, selectionLayer, cursorLayer];
}
