import { App, Notice, TFile } from 'obsidian';
import * as Y from 'yjs';
import type { SyncManager } from '../syncManager';
import type { CursorUser } from '../types';
import type { ManifestManager } from '../files/manifestManager';
import { applyMinimalYTextUpdate, getFileByPath, isExcalidrawFile, normalizeLineEndings, toLocalPath } from '../utils';
import { reconcileExcalidrawElements, type ExcalidrawElementStub } from './excalidrawReconcile';

export interface ExcalidrawApi {
	getSceneElementsIncludingDeleted?: () => ExcalidrawElementStub[];
	getSceneElements?: () => ExcalidrawElementStub[];
	getAppState?: () => { zoom?: { value?: number }; scrollX?: number; scrollY?: number; editingElement?: { id?: string }; draggingElement?: { id?: string }; resizingElement?: { id?: string } };
	updateScene: (sceneData: { elements?: ExcalidrawElementStub[]; commitToHistory?: boolean }) => void;
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
	private activationGen = 0;
	private yElementsObserver: ((event: Y.YMapEvent<string>, transaction: Y.Transaction) => void) | null = null;
	private domCleanup: (() => void) | null = null;
	private syncIntervalTimer: number | null = null;
	private isApplyingRemote = false;
	private lastBroadcastFingerprints = new Map<string, string>();
	private lastElementVersions = new Map<string, number>();
	private saveDebounceTimer: number | null = null;
	private manifestManager: ManifestManager | null = null;
	private isPointerDown = false;
	private hasPendingRemote = false;

	constructor(
		private readonly app: App,
		private readonly sync: SyncManager,
		private readonly hasFile: (path: string) => boolean,
	) {}

	setManifestManager(mm: ManifestManager): void {
		this.manifestManager = mm;
	}

	async activateForFile(file: TFile | null, _cursorUser?: CursorUser): Promise<boolean> {
		const gen = ++this.activationGen;

		if (!file || !isExcalidrawFile(file.path)) {
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
			new Notice('Excalidraw sync timed out');
			this.unbind();
			return false;
		}

		if (this.activationGen !== gen) return false;

		const activeAPI = excalidrawAPI as unknown as ExcalidrawApi;
		const yElements = docHandle.doc.getMap<string>('excalidraw_elements');

		// Initial sync between Yjs elements map and local Excalidraw scene
		const initialSceneElements = activeAPI.getSceneElementsIncludingDeleted?.() ??
			activeAPI.getSceneElements?.() ??
			[];
		if (yElements.size === 0 && initialSceneElements.length > 0) {
			docHandle.doc.transact(() => {
				for (const el of initialSceneElements) {
					yElements.set(el.id, JSON.stringify(el));
					this.lastBroadcastFingerprints.set(el.id, getElementFingerprint(el));
					this.lastElementVersions.set(el.id, typeof el.version === 'number' ? el.version : 1);
				}
			}, 'initial_seed');
		} else if (yElements.size > 0) {
			const remoteElements: ExcalidrawElementStub[] = [];
			for (const raw of yElements.values()) {
				try {
					remoteElements.push(JSON.parse(raw) as ExcalidrawElementStub);
				} catch {
					// Ignore invalid JSON
				}
			}
			const activeId = activeAPI.getAppState?.()?.editingElement?.id ?? undefined;
			const reconciled = reconcileExcalidrawElements(initialSceneElements, remoteElements, activeId);
			this.isApplyingRemote = true;
			try {
				const visibleElements = reconciled.filter((el) => !el.isDeleted);
				activeAPI.updateScene({ elements: visibleElements, commitToHistory: false });
				for (const el of reconciled) {
					if (el.id !== activeId) {
						if (el.isDeleted) {
							this.lastBroadcastFingerprints.delete(el.id);
						} else {
							this.lastBroadcastFingerprints.set(el.id, getElementFingerprint(el));
						}
						this.lastElementVersions.set(el.id, typeof el.version === 'number' ? el.version : 1);
					}
				}
			} finally {
				this.isApplyingRemote = false;
			}
		}

		// Listen to remote changes in Yjs elements map
		this.yElementsObserver = (_event, transaction) => {
			if (transaction.origin === 'local' || transaction.origin === 'initial_seed') return;
			if (!this.currentView || !activeAPI) return;

			// If local user is actively drawing or dragging, defer remote scene update until pointerup
			if (this.isPointerDown) {
				this.hasPendingRemote = true;
				return;
			}

			this.applyRemoteUpdate(activeAPI, yElements);
		};
		yElements.observe(this.yElementsObserver);

		// DOM pointer listeners on container as safety triggers for local sync
		const viewDom = (excalidrawView as { contentEl?: HTMLElement })?.contentEl;
		if (viewDom) {
			const onPointerDown = () => {
				this.isPointerDown = true;
			};

			const onPointerUp = () => {
				this.isPointerDown = false;
				this.syncLocalChanges(activeAPI, yElements, docHandle.doc);
				if (this.hasPendingRemote) {
					this.hasPendingRemote = false;
					this.applyRemoteUpdate(activeAPI, yElements);
				}
			};

			const onBlur = () => {
				if (this.isPointerDown) {
					this.isPointerDown = false;
					this.syncLocalChanges(activeAPI, yElements, docHandle.doc);
					if (this.hasPendingRemote) {
						this.hasPendingRemote = false;
						this.applyRemoteUpdate(activeAPI, yElements);
					}
				}
			};

			viewDom.addEventListener('pointerdown', onPointerDown as EventListener, { passive: true });
			viewDom.addEventListener('touchstart', onPointerDown as EventListener, { passive: true });
			window.addEventListener('pointerup', onPointerUp as EventListener, { passive: true });
			window.addEventListener('touchend', onPointerUp as EventListener, { passive: true });
			window.addEventListener('pointercancel', onPointerUp as EventListener, { passive: true });
			window.addEventListener('blur', onBlur);

			this.domCleanup = () => {
				viewDom.removeEventListener('pointerdown', onPointerDown as EventListener);
				viewDom.removeEventListener('touchstart', onPointerDown as EventListener);
				window.removeEventListener('pointerup', onPointerUp as EventListener);
				window.removeEventListener('touchend', onPointerUp as EventListener);
				window.removeEventListener('pointercancel', onPointerUp as EventListener);
				window.removeEventListener('blur', onBlur);
			};
		}

		// High-frequency sync loop (every 40ms) to detect and broadcast strokes & erasures in real time
		this.syncIntervalTimer = window.setInterval(() => {
			this.syncLocalChanges(activeAPI, yElements, docHandle.doc);
		}, 40);

		return true;
	}

	private applyRemoteUpdate(activeAPI: ExcalidrawApi, yElements: Y.Map<string>): void {
		if (this.isApplyingRemote || !activeAPI || !this.currentPath) return;

		const currentLocal = (activeAPI.getSceneElementsIncludingDeleted?.() ??
			activeAPI.getSceneElements?.() ??
			[]).slice();

		const activeLocalIds = new Set<string>();
		if (this.isPointerDown) {
			const appState = activeAPI.getAppState?.();
			const activeDrawingId = (appState as { newElement?: { id?: string } })?.newElement?.id;
			const activeEditId = appState?.editingElement?.id ??
				appState?.draggingElement?.id ??
				appState?.resizingElement?.id ??
				undefined;
			if (activeDrawingId) activeLocalIds.add(activeDrawingId);
			if (activeEditId) activeLocalIds.add(activeEditId);
		}

		const currentRemote: ExcalidrawElementStub[] = [];
		for (const raw of yElements.values()) {
			try {
				currentRemote.push(JSON.parse(raw) as ExcalidrawElementStub);
			} catch {
				// Ignore invalid JSON
			}
		}

		const reconciled = reconcileExcalidrawElements(currentLocal, currentRemote, activeLocalIds);
		this.isApplyingRemote = true;
		try {
			const visibleElements = reconciled.filter((el) => !el.isDeleted);
			activeAPI.updateScene({ elements: visibleElements, commitToHistory: false });
			for (const el of reconciled) {
				if (!activeLocalIds.has(el.id)) {
					if (el.isDeleted) {
						this.lastBroadcastFingerprints.delete(el.id);
					} else {
						this.lastBroadcastFingerprints.set(el.id, getElementFingerprint(el));
					}
					this.lastElementVersions.set(el.id, typeof el.version === 'number' ? el.version : 1);
				}
			}
			this.scheduleSaveToDisk();
		} finally {
			this.isApplyingRemote = false;
		}
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

		const elements = (excalidrawAPI.getSceneElementsIncludingDeleted?.() ??
			excalidrawAPI.getSceneElements?.() ??
			[]).slice();

		// Include active newElement (stroke being drawn) so it is broadcast in real time
		if (this.isPointerDown) {
			const appState = excalidrawAPI.getAppState?.();
			const newElement = (appState as { newElement?: ExcalidrawElementStub })?.newElement;
			if (newElement && newElement.id && !elements.some((e) => e.id === newElement.id)) {
				elements.push(newElement);
			}
		}

		if (elements.length === 0 && this.lastBroadcastFingerprints.size === 0) return;

		const currentIds = new Set<string>();
		const localElementMap = new Map<string, ExcalidrawElementStub>();
		const changed: ExcalidrawElementStub[] = [];
		const deletedIds: string[] = [];

		for (const el of elements) {
			currentIds.add(el.id);
			localElementMap.set(el.id, el);

			if (el.isDeleted) {
				const yRaw = yElements.get(el.id);
				let yIsDeleted = false;
				if (yRaw) {
					try {
						const parsed = JSON.parse(yRaw) as { isDeleted?: boolean };
						yIsDeleted = !!parsed.isDeleted;
					} catch {
						// Ignore JSON parse error
					}
				}
				if (this.lastBroadcastFingerprints.has(el.id) || (yRaw && !yIsDeleted)) {
					this.lastBroadcastFingerprints.delete(el.id);
					deletedIds.push(el.id);
				}
				continue;
			}

			const fp = getElementFingerprint(el);
			if (this.lastBroadcastFingerprints.get(el.id) !== fp) {
				this.lastBroadcastFingerprints.set(el.id, fp);
				changed.push(el);
			}
		}

		for (const id of this.lastBroadcastFingerprints.keys()) {
			if (!currentIds.has(id)) {
				this.lastBroadcastFingerprints.delete(id);
				deletedIds.push(id);
			}
		}

		if (changed.length > 0 || deletedIds.length > 0) {
			ydoc.transact(() => {
				for (const el of changed) {
					const lastVer = this.lastElementVersions.get(el.id) ?? (typeof el.version === 'number' ? el.version : 1);
					const newVer = Math.max(lastVer + 1, (typeof el.version === 'number' ? el.version : 1) + 1);
					el.version = newVer;
					this.lastElementVersions.set(el.id, newVer);
					yElements.set(el.id, JSON.stringify(el));
				}
				for (const id of deletedIds) {
					let base: Record<string, unknown> = {};
					const rawY = yElements.get(id);
					let yVer = 0;
					if (rawY) {
						try {
							base = JSON.parse(rawY) as Record<string, unknown>;
							if (typeof base.version === 'number') {
								yVer = base.version;
							}
						} catch {
							// Ignore JSON parse error
						}
					}
					const localEl = localElementMap.get(id);
					const localVer = typeof localEl?.version === 'number' ? localEl.version : 0;
					const trackedVer = this.lastElementVersions.get(id) ?? 0;
					const newVer = Math.max(yVer, localVer, trackedVer) + 1;

					this.lastElementVersions.set(id, newVer);
					this.lastBroadcastFingerprints.delete(id);

					const deletedStub: ExcalidrawElementStub = {
						...base,
						...(localEl ?? {}),
						id,
						isDeleted: true,
						version: newVer,
						versionNonce: Math.floor(Math.random() * 1000000),
						updated: Date.now(),
					};
					yElements.set(id, JSON.stringify(deletedStub));
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

		this.currentPath = null;
		this.currentView = null;
		this.isPointerDown = false;
		this.hasPendingRemote = false;
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
