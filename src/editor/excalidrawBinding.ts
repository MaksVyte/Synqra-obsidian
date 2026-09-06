import { App, Notice, TFile } from 'obsidian';
import * as Y from 'yjs';
import type * as awarenessProtocol from 'y-protocols/awareness';
import type { SyncManager } from '../syncManager';
import type { CursorUser } from '../types';
import type { ManifestManager } from '../files/manifestManager';
import { applyMinimalYTextUpdate, getFileByPath, isExcalidrawFile, normalizeLineEndings, toLocalPath } from '../utils';
import { reconcileExcalidrawElements, type ExcalidrawElementStub } from './excalidrawReconcile';

export interface ExcalidrawCollaborator {
	pointer?: { x: number; y: number };
	button?: 'down' | 'up';
	username?: string;
	color?: {
		background?: string;
		stroke?: string;
	};
	selectedElementIds?: Record<string, boolean>;
}

export interface ExcalidrawApi {
	getSceneElementsIncludingDeleted?: () => ExcalidrawElementStub[];
	getSceneElements?: () => ExcalidrawElementStub[];
	getAppState?: () => { zoom?: { value?: number }; scrollX?: number; scrollY?: number; editingElement?: { id?: string }; draggingElement?: { id?: string }; resizingElement?: { id?: string } };
	updateScene: (sceneData: { elements?: ExcalidrawElementStub[]; collaborators?: Map<string, ExcalidrawCollaborator>; commitToHistory?: boolean }) => void;
	onPointerUpdate?: (cb: (payload: { pointer: { x: number; y: number }; button: 'down' | 'up'; pointersMap?: Map<number, unknown> }) => void) => () => void;
}

function getElementFingerprint(el: ExcalidrawElementStub | Record<string, unknown>): string {
	const points = Array.isArray(el.points) ? el.points : [];
	const pointsLen = points.length;
	const id = typeof el.id === 'string' || typeof el.id === 'number' ? String(el.id) : '';
	const version = typeof el.version === 'string' || typeof el.version === 'number' ? String(el.version) : '';
	const nonce = typeof el.versionNonce === 'string' || typeof el.versionNonce === 'number' ? String(el.versionNonce) : '';
	const x = typeof el.x === 'number' ? String(el.x) : '';
	const y = typeof el.y === 'number' ? String(el.y) : '';
	const w = typeof el.width === 'number' ? String(el.width) : '';
	const h = typeof el.height === 'number' ? String(el.height) : '';
	const del = el.isDeleted ? 1 : 0;
	const text = typeof el.text === 'string' ? el.text : '';
	return `${id}_${version}_${nonce}_${x}_${y}_${w}_${h}_${pointsLen}_${del}_${text}`;
}

export class ExcalidrawBinding {
	private currentPath: string | null = null;
	private currentView: unknown = null;
	private currentAwareness: awarenessProtocol.Awareness | null = null;
	private currentCursorUser: CursorUser | undefined = undefined;
	private activationGen = 0;
	private yElementsObserver: ((event: Y.YMapEvent<string>, transaction: Y.Transaction) => void) | null = null;
	private awarenessObserver: (() => void) | null = null;
	private unsubscribePointer: (() => void) | null = null;
	private domCleanup: (() => void) | null = null;
	private syncIntervalTimer: number | null = null;
	private isApplyingRemote = false;
	private lastBroadcastFingerprints = new Map<string, string>();
	private lastElementVersions = new Map<string, number>();
	private saveDebounceTimer: number | null = null;
	private manifestManager: ManifestManager | null = null;

	constructor(
		private readonly app: App,
		private readonly sync: SyncManager,
		private readonly hasFile: (path: string) => boolean,
	) {}

	setManifestManager(manifestManager: ManifestManager): void {
		this.manifestManager = manifestManager;
	}

	async activateForFile(
		file: TFile | null,
		cursorUser?: CursorUser,
	): Promise<boolean> {
		const gen = ++this.activationGen;

		if (cursorUser) {
			this.currentCursorUser = cursorUser;
		}

		if (!file || !isExcalidrawFile(file.path) || !this.hasFile(file.path)) {
			this.unbind();
			return false;
		}

		let excalidrawView: unknown = null;
		let excalidrawAPI: ExcalidrawApi | null = null;

		for (let attempt = 0; attempt < 8; attempt++) {
			this.app.workspace.iterateAllLeaves((l) => {
				const view = l.view as { getViewType?: () => string; excalidrawAPI?: ExcalidrawApi; file?: { path: string } };
				if (view && (view.getViewType?.() === 'excalidraw' || view.excalidrawAPI)) {
					if (!file || !view.file || view.file.path === file.path) {
						excalidrawView = view;
						excalidrawAPI = view.excalidrawAPI ?? null;
					}
				}
			});
			if (excalidrawAPI) break;
			await new Promise((resolve) => window.setTimeout(resolve, 50));
			if (this.activationGen !== gen) return false;
		}

		if (!excalidrawAPI) {
			this.unbind();
			return false;
		}

		const filePath = file?.path ?? null;
		if (filePath !== this.currentPath || excalidrawView !== this.currentView) {
			this.unbind();
		}

		this.currentPath = filePath;
		this.currentView = excalidrawView;

		if (!filePath || !this.hasFile(filePath)) {
			this.unbind();
			return false;
		}

		const docHandle = this.sync.getDoc(filePath);
		if (!docHandle) {
			this.unbind();
			return false;
		}

		try {
			await this.sync.waitForSync(filePath);
		} catch {
			if (this.activationGen !== gen) return false;
			new Notice('[Synqra] Excalidraw sync timed out');
			this.unbind();
			return false;
		}

		if (this.activationGen !== gen) return false;

		const activeAPI = excalidrawAPI as unknown as ExcalidrawApi;
		const yElements = docHandle.doc.getMap<string>('excalidraw_elements');
		this.currentAwareness = docHandle.awareness;

		// Set local user awareness
		const userToUse = this.currentCursorUser;
		if (userToUse) {
			const existing = docHandle.awareness.getLocalState() || {};
			docHandle.awareness.setLocalState({
				...existing,
				user: {
					name: userToUse.name,
					color: userToUse.color,
					colorLight: userToUse.color + '33',
				},
			});
		}

		// Initial sync between Yjs elements map and local Excalidraw scene
		const initialSceneElements = activeAPI.getSceneElementsIncludingDeleted?.() ??
			activeAPI.getSceneElements?.() ??
			[];
		if (yElements.size === 0 && initialSceneElements.length > 0) {
			docHandle.doc.transact(() => {
				for (const el of initialSceneElements) {
					yElements.set(el.id, JSON.stringify(el));
					if (!el.isDeleted) {
						this.lastBroadcastFingerprints.set(el.id, getElementFingerprint(el));
					}
				}
			}, 'local');
		} else if (yElements.size > 0) {
			const remoteElements: ExcalidrawElementStub[] = [];
			for (const raw of yElements.values()) {
				try {
					remoteElements.push(JSON.parse(raw) as ExcalidrawElementStub);
				} catch {
					// Ignore invalid JSON from corrupted chunk
				}
			}
			const merged = reconcileExcalidrawElements(initialSceneElements, remoteElements);
			this.isApplyingRemote = true;
			try {
				activeAPI.updateScene({ elements: merged, commitToHistory: false });
				for (const el of merged) {
					if (el.isDeleted) {
						this.lastBroadcastFingerprints.delete(el.id);
					} else {
						this.lastBroadcastFingerprints.set(el.id, getElementFingerprint(el));
					}
				}
			} finally {
				this.isApplyingRemote = false;
			}
		}

		// Observe remote element updates
		this.yElementsObserver = (_event: Y.YMapEvent<string>, transaction: Y.Transaction) => {
			if (transaction.local || this.isApplyingRemote) return;

			const appState = activeAPI.getAppState?.() || {};
			const activeId =
				appState.editingElement?.id ||
				appState.draggingElement?.id ||
				appState.resizingElement?.id;

			const currentLocal = activeAPI.getSceneElementsIncludingDeleted?.() ??
				activeAPI.getSceneElements?.() ??
				[];
			const currentRemote: ExcalidrawElementStub[] = [];
			for (const raw of yElements.values()) {
				try {
					currentRemote.push(JSON.parse(raw) as ExcalidrawElementStub);
				} catch {
					// Ignore invalid JSON
				}
			}

			const reconciled = reconcileExcalidrawElements(currentLocal, currentRemote, activeId);
			this.isApplyingRemote = true;
			try {
				activeAPI.updateScene({ elements: reconciled, commitToHistory: false });
				for (const el of reconciled) {
					if (el.id !== activeId) {
						if (el.isDeleted) {
							this.lastBroadcastFingerprints.delete(el.id);
						} else {
							this.lastBroadcastFingerprints.set(el.id, getElementFingerprint(el));
						}
					}
				}
				this.scheduleSaveToDisk();
			} finally {
				this.isApplyingRemote = false;
			}
		};
		yElements.observe(this.yElementsObserver);

		// Observe local pointer updates to broadcast live cursor
		if (typeof activeAPI.onPointerUpdate === 'function') {
			this.unsubscribePointer = activeAPI.onPointerUpdate((payload: {
				pointer: { x: number; y: number };
				button: 'down' | 'up';
				pointersMap?: Map<number, unknown>;
			}) => {
				if (!this.currentAwareness) return;
				this.currentAwareness.setLocalStateField('pointer', payload.pointer);
				this.currentAwareness.setLocalStateField('button', payload.button);

				if (payload.button === 'up') {
					window.setTimeout(() => {
						this.syncLocalChanges(activeAPI, yElements, docHandle.doc);
					}, 10);
				}
			});
		}

		// DOM pointer & touch listeners on container for cross-platform / mobile responsiveness
		const viewDom = (excalidrawView as { contentEl?: HTMLElement })?.contentEl;
		if (viewDom) {
			const onPointerMove = (e: PointerEvent | TouchEvent) => {
				if (!this.currentAwareness) return;
				let clientX: number | undefined;
				let clientY: number | undefined;
				if ('clientX' in e && typeof e.clientX === 'number') {
					clientX = e.clientX;
					clientY = e.clientY;
				} else if ('touches' in e && e.touches.length > 0) {
					const touch = e.touches[0];
					if (touch) {
						clientX = touch.clientX;
						clientY = touch.clientY;
					}
				}
				if (clientX === undefined || clientY === undefined) return;

				const rect = viewDom.getBoundingClientRect();
				const appState = activeAPI.getAppState?.() || {};
				const zoom = appState.zoom?.value || 1;
				const scrollX = appState.scrollX || 0;
				const scrollY = appState.scrollY || 0;
				const canvasX = (clientX - rect.left - scrollX) / zoom;
				const canvasY = (clientY - rect.top - scrollY) / zoom;
				this.currentAwareness.setLocalStateField('pointer', { x: canvasX, y: canvasY });
			};

			const onPointerUp = () => {
				window.setTimeout(() => {
					this.syncLocalChanges(activeAPI, yElements, docHandle.doc);
				}, 10);
			};

			viewDom.addEventListener('pointermove', onPointerMove as EventListener, { passive: true });
			viewDom.addEventListener('pointerup', onPointerUp as EventListener, { passive: true });
			viewDom.addEventListener('touchmove', onPointerMove as EventListener, { passive: true });
			viewDom.addEventListener('touchend', onPointerUp as EventListener, { passive: true });

			this.domCleanup = () => {
				viewDom.removeEventListener('pointermove', onPointerMove as EventListener);
				viewDom.removeEventListener('pointerup', onPointerUp as EventListener);
				viewDom.removeEventListener('touchmove', onPointerMove as EventListener);
				viewDom.removeEventListener('touchend', onPointerUp as EventListener);
			};
		}

		// Observe remote awareness to render collaborators on canvas in real-time
		this.awarenessObserver = () => {
			if (!this.currentAwareness) return;
			const collaborators = new Map<string, ExcalidrawCollaborator>();
			const localClientId = docHandle.awareness.doc.clientID;

			docHandle.awareness.getStates().forEach((state: unknown, clientId: number) => {
				if (clientId === localClientId) return;
				const s = state as { pointer?: { x: number; y: number }; button?: 'down' | 'up'; user?: { color?: string; name?: string }; selectedElementIds?: Record<string, boolean> };
				if (!s || !s.pointer) return;

				const { color = '#30bced', name = 'Anonymous' } = s.user || {};
				collaborators.set(clientId.toString(), {
					pointer: s.pointer,
					button: s.button || 'up',
					username: name,
					color: {
						background: color,
						stroke: color,
					},
					selectedElementIds: s.selectedElementIds || {},
				});
			});

			try {
				activeAPI.updateScene({ collaborators });
			} catch {
				// Ignore scene update error
			}
		};
		docHandle.awareness.on('change', this.awarenessObserver);

		// High-frequency sync loop (every 40ms) to detect and broadcast strokes & erasures in real time
		this.syncIntervalTimer = window.setInterval(() => {
			this.syncLocalChanges(activeAPI, yElements, docHandle.doc);
		}, 40);

		return true;
	}

	private syncLocalChanges(
		excalidrawAPI: ExcalidrawApi,
		yElements: Y.Map<string>,
		ydoc: Y.Doc,
	): void {
		if (this.isApplyingRemote || !excalidrawAPI || !this.currentPath) return;

		const viewDom = (this.currentView as { contentEl?: HTMLElement })?.contentEl;
		if (!viewDom || !viewDom.isConnected) {
			return;
		}

		const elements = excalidrawAPI.getSceneElementsIncludingDeleted?.() ??
			excalidrawAPI.getSceneElements?.() ??
			[];
		if (elements.length === 0) return;

		const currentIds = new Set<string>();
		const changed: ExcalidrawElementStub[] = [];
		const deletedIds: string[] = [];

		for (const el of elements) {
			currentIds.add(el.id);
			if (typeof el.version === 'number') {
				this.lastElementVersions.set(el.id, el.version);
			}
			if (el.isDeleted) {
				if (this.lastBroadcastFingerprints.has(el.id)) {
					deletedIds.push(el.id);
					this.lastBroadcastFingerprints.delete(el.id);
				}
				continue;
			}
			const fp = getElementFingerprint(el);
			const lastFp = this.lastBroadcastFingerprints.get(el.id);
			if (lastFp !== fp) {
				changed.push(el);
				this.lastBroadcastFingerprints.set(el.id, fp);
			}
		}

		if (changed.length > 0 || deletedIds.length > 0) {
			ydoc.transact(() => {
				for (const el of changed) {
					yElements.set(el.id, JSON.stringify(el));
				}
				for (const id of deletedIds) {
					const lastVer = this.lastElementVersions.get(id) ?? 1;
					const newVer = lastVer + 1;
					this.lastElementVersions.set(id, newVer);
					yElements.set(
						id,
						JSON.stringify({
							id,
							isDeleted: true,
							version: newVer,
							versionNonce: Math.floor(Math.random() * 1000000),
						}),
					);
				}
			}, 'local');
		}
	}

	private scheduleSaveToDisk(): void {
		if (this.saveDebounceTimer !== null) {
			window.clearTimeout(this.saveDebounceTimer);
		}
		this.saveDebounceTimer = window.setTimeout(() => {
			this.saveDebounceTimer = null;
			void this.flushExcalidrawDiskContent();
		}, 1000);
	}

	private async flushExcalidrawDiskContent(targetPath?: string, targetView?: unknown): Promise<void> {
		const path = targetPath ?? this.currentPath;
		if (!path) return;
		const view = (targetView ?? this.currentView) as { save?: (prompt?: boolean) => Promise<void>; file?: TFile };
		if (typeof view?.save === 'function') {
			try {
				await view.save(false);
			} catch {
				// Ignore save error
			}
		}
		const file = view?.file ?? getFileByPath(this.app.vault, toLocalPath(path));
		if (file) {
			try {
				const content = normalizeLineEndings(await this.app.vault.read(file));
				const docHandle = this.sync.getDoc(path);
				if (docHandle && content && docHandle.text.toString() !== content) {
					applyMinimalYTextUpdate(docHandle.doc, docHandle.text, content);
				}
				if (this.manifestManager) {
					await this.manifestManager.updateFile(file, content);
				}
			} catch {
				// Ignore file read error
			}
		}
	}

	unbind(skipFlush = false): void {
		if (this.syncIntervalTimer !== null) {
			window.clearInterval(this.syncIntervalTimer);
			this.syncIntervalTimer = null;
		}

		if (this.saveDebounceTimer !== null) {
			window.clearTimeout(this.saveDebounceTimer);
			this.saveDebounceTimer = null;
		}

		const pathToFlush = this.currentPath;
		const viewToFlush = this.currentView;

		if (pathToFlush && !skipFlush) {
			void this.flushExcalidrawDiskContent(pathToFlush, viewToFlush);
		}

		if (this.domCleanup) {
			this.domCleanup();
			this.domCleanup = null;
		}

		if (this.yElementsObserver && pathToFlush) {
			const docHandle = this.sync.getDoc(pathToFlush);
			if (docHandle) {
				const yElements = docHandle.doc.getMap<string>('excalidraw_elements');
				yElements.unobserve(this.yElementsObserver);
			}
			this.yElementsObserver = null;
		}

		if (this.awarenessObserver && this.currentAwareness) {
			this.currentAwareness.off('change', this.awarenessObserver);
			this.currentAwareness.setLocalState(null);
			this.awarenessObserver = null;
		}

		if (this.unsubscribePointer) {
			this.unsubscribePointer();
			this.unsubscribePointer = null;
		}

		this.currentAwareness = null;
		this.currentPath = null;
		this.currentView = null;
		this.lastBroadcastFingerprints.clear();
		this.lastElementVersions.clear();
	}

	getCurrentPath(): string | null {
		return this.currentPath;
	}

	destroy(): void {
		this.activationGen++;
		this.unbind();
	}
}
