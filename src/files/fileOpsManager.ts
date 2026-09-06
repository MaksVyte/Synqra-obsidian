import { App, Notice, TFile, type FileManager, type Vault } from 'obsidian';
import type { FileOp } from '../types';
import {
	VAULT_EVENT_SETTLE_MS,
	arrayBufferToBase64,
	base64ToArrayBuffer,
	ensureFolder,
	isTextFile,
	normalizeLineEndings,
	normalizePath,
	toCanonicalPath,
	toLocalPath,
} from '../utils';

import type { BackgroundSync } from './backgroundSync';
import type { ManifestManager } from './manifestManager';

const CHUNK_SIZE = 512 * 1024;
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MAX_WIRE_SIZE = Math.ceil((MAX_FILE_SIZE * 4) / 3) + 1024;

interface ChunkAssembly {
	chunks: string[];
	totalSize: number;
	binary?: boolean;
	transferId?: string;
	lastActivity: number;
}

export class FileOpsManager {
	private sendOp: ((op: FileOp) => void) | null = null;
	private manifestManager: ManifestManager | null = null;
	private backgroundSync: BackgroundSync | null = null;
	private onActiveFileRename?: (oldPath: string, newPath: string) => void;
	private mutedPaths = new Map<string, number>();
	private pendingChunks = new Map<string, ChunkAssembly>();
	private opQueues = new Map<string, Promise<void>>();
	private sendQueues = new Map<string, Promise<void>>();
	private isApplyingRemoteOp = false;
	private chunkGcTimer: number | null = null;

	constructor(
		private readonly app: App,
		private readonly vault: Vault,
		private readonly fileManager: FileManager,
	) {
		this.chunkGcTimer = window.setInterval(() => {
			const now = Date.now();
			for (const [key, assembly] of this.pendingChunks) {
				if (now - assembly.lastActivity > 10 * 60 * 1000) {
					this.pendingChunks.delete(key);
				}
			}
		}, 60_000);
	}

	private editorBinding?: { getCurrentPath: () => string | null; unbind: () => void };
	private excalidrawBinding?: { getCurrentPath: () => string | null; unbind: (skipFlush?: boolean) => void };

	setSender(sender: (op: FileOp) => void) {
		this.sendOp = sender;
	}

	setEditorBindings(
		editorBinding: { getCurrentPath: () => string | null; unbind: () => void },
		excalidrawBinding: { getCurrentPath: () => string | null; unbind: (skipFlush?: boolean) => void },
	): void {
		this.editorBinding = editorBinding;
		this.excalidrawBinding = excalidrawBinding;
	}

	setSyncDependencies(manifestManager: ManifestManager, backgroundSync: BackgroundSync) {
		this.manifestManager = manifestManager;
		this.backgroundSync = backgroundSync;
	}

	setActiveFileRenameHandler(handler: (oldPath: string, newPath: string) => void) {
		this.onActiveFileRename = handler;
	}

	destroy(): void {
		if (this.chunkGcTimer !== null) {
			window.clearInterval(this.chunkGcTimer);
			this.chunkGcTimer = null;
		}
		this.pendingChunks.clear();
		this.mutedPaths.clear();
		this.onActiveFileRename = undefined;
		this.opQueues.clear();
		this.sendQueues.clear();
	}

	mutePathEvents(path: string): void {
		const norm = normalizePath(path);
		this.mutedPaths.set(norm, (this.mutedPaths.get(norm) ?? 0) + 1);
	}

	unmutePathEvents(path: string): void {
		const norm = normalizePath(path);
		const count = this.mutedPaths.get(norm) ?? 0;
		if (count <= 1) {
			this.mutedPaths.delete(norm);
		} else {
			this.mutedPaths.set(norm, count - 1);
		}
	}

	isPathMuted(path: string): boolean {
		const norm = normalizePath(path);
		if ((this.mutedPaths.get(norm) ?? 0) > 0) return true;
		for (const [muted, count] of this.mutedPaths) {
			if (count > 0 && (norm.startsWith(muted + '/') || norm === muted)) {
				return true;
			}
		}
		return false;
	}

	async applyRemoteOp(op: FileOp): Promise<void> {
		const paths = this.getOpPaths(op);

		const currentQueues = paths.map((path) => this.opQueues.get(path) ?? Promise.resolve());
		const gate = Promise.all(currentQueues);

		const promise = gate.then(async () => {
			await this.applyRemoteOpInner(op);
		});

		for (const path of paths) this.opQueues.set(path, promise);

		try {
			await promise;
		} finally {
			for (const path of paths) {
				if (this.opQueues.get(path) === promise) this.opQueues.delete(path);
			}
		}
	}

	private getOpPaths(op: FileOp): string[] {
		const paths: string[] = [];
		if ('path' in op) paths.push(normalizePath(op.path));
		if ('oldPath' in op) paths.push(normalizePath(op.oldPath));
		if ('newPath' in op) paths.push(normalizePath(op.newPath));
		return paths;
	}

	private async applyRemoteOpInner(rawOp: FileOp): Promise<void> {
		const op = { ...rawOp };
		if ('path' in op) op.path = toLocalPath(normalizePath(op.path));
		if ('oldPath' in op) op.oldPath = toLocalPath(normalizePath(op.oldPath));
		if ('newPath' in op) op.newPath = toLocalPath(normalizePath(op.newPath));

		const paths = this.getOpPaths(op);
		for (const path of paths) this.mutePathEvents(path);
		try {
			switch (op.type) {
				case 'create': {
					const exists = this.vault.getAbstractFileByPath(op.path);
					if (exists && exists instanceof TFile) {
						if (op.binary) {
							await this.vault.modifyBinary(exists, base64ToArrayBuffer(op.content));
						} else {
							await this.vault.modify(exists, op.content);
						}
					} else if (!exists) {
						const parentDir = op.path.substring(0, op.path.lastIndexOf('/'));
						if (parentDir) await ensureFolder(this.vault, parentDir);
						if (op.binary) {
							await this.vault.createBinary(op.path, base64ToArrayBuffer(op.content));
						} else {
							await this.vault.create(op.path, op.content);
						}
					}
					const target = this.vault.getAbstractFileByPath(op.path);
					if (target instanceof TFile) {
						const canonical = toCanonicalPath(op.path);
						if (op.binary) {
							void this.manifestManager?.updateFile(target, base64ToArrayBuffer(op.content));
						} else {
							void this.manifestManager?.updateFile(target, op.content);
							void this.backgroundSync?.onFileAdded(canonical);
						}
					}
					break;
				}
				case 'modify': {
					const file = this.vault.getAbstractFileByPath(op.path);
					if (file instanceof TFile) {
						if (op.binary) {
							await this.vault.modifyBinary(file, base64ToArrayBuffer(op.content));
							void this.manifestManager?.updateFile(file, base64ToArrayBuffer(op.content));
						} else {
							await this.vault.modify(file, op.content);
							void this.manifestManager?.updateFile(file, op.content);
						}
					}
					break;
				}
				case 'delete': {
					const file = this.vault.getAbstractFileByPath(op.path);
					if (this.editorBinding?.getCurrentPath() === op.path) {
						this.editorBinding.unbind();
					}
					if (this.excalidrawBinding?.getCurrentPath() === op.path) {
						this.excalidrawBinding.unbind(true);
					}
					// Detach any open leaves for this file or sub-files if folder to release locks and prevent resurrection
					const prefix = op.path.endsWith('/') ? op.path : op.path + '/';
					this.app.workspace.iterateAllLeaves((leaf) => {
						const view = leaf.view as { file?: { path: string } };
						const p = view?.file?.path;
						if (p && (p === op.path || p.startsWith(prefix) || (file && (p === file.path || p.startsWith(file.path + '/'))))) {
							void leaf.setViewState({ type: 'empty' });
							leaf.detach();
						}
					});

					if (file) {
						try {
							await this.fileManager.trashFile(file);
						} catch {
							try {
								await this.vault.adapter.remove(op.path);
							} catch {
								// Ignore if already deleted
							}
						}
					} else {
						try {
							await this.vault.adapter.remove(op.path);
						} catch {
							// Ignore if already deleted
						}
					}
					const canonical = toCanonicalPath(op.path);
					this.manifestManager?.removeFile(canonical);
					this.backgroundSync?.onFileRemoved(canonical);
					this.pendingChunks.delete(op.path);
					break;
				}
				case 'rename': {
					const file = this.vault.getAbstractFileByPath(op.oldPath);
					const alreadyExists = this.vault.getAbstractFileByPath(op.newPath);
					const isSameFile = Boolean(file && alreadyExists && file === alreadyExists);
					if (file && (!alreadyExists || isSameFile)) {
						const parentDir = op.newPath.substring(0, op.newPath.lastIndexOf('/'));
						if (parentDir) await ensureFolder(this.vault, parentDir);
						try {
							await this.vault.rename(file, op.newPath);
						} catch (err) {
							if (!this.vault.getAbstractFileByPath(op.newPath)) throw err;
						}
					} else if (file && alreadyExists && !isSameFile) {
						await this.fileManager.trashFile(file);
					}
					const oldCanonical = toCanonicalPath(op.oldPath);
					const newCanonical = toCanonicalPath(op.newPath);
					this.manifestManager?.renameFile(oldCanonical, newCanonical);
					void this.backgroundSync?.onFileRenamed(oldCanonical, newCanonical);
					this.onActiveFileRename?.(op.oldPath, op.newPath);
					break;
				}
				case 'chunk-start': {
					if (op.totalSize <= 0 || op.totalSize > MAX_WIRE_SIZE) break;
					const chunkKey = op.transferId ?? op.path;
					this.pendingChunks.set(chunkKey, {
						chunks: [],
						totalSize: op.totalSize,
						binary: op.binary,
						transferId: op.transferId,
						lastActivity: Date.now(),
					});
					break;
				}
				case 'chunk-data': {
					const dataKey = op.transferId ?? op.path;
					const assembly = this.pendingChunks.get(dataKey);
					if (assembly) {
						assembly.chunks[op.index] = op.data;
						assembly.lastActivity = Date.now();
					}
					break;
				}
				case 'chunk-end': {
					const endKey = op.transferId ?? op.path;
					const assembly = this.pendingChunks.get(endKey);
					if (!assembly) break;
					this.pendingChunks.delete(endKey);

					let hasMissingChunks = assembly.chunks.length === 0;
					for (let i = 0; i < assembly.chunks.length; i++) {
						if (typeof assembly.chunks[i] !== 'string') {
							hasMissingChunks = true;
							break;
						}
					}
					const joined = hasMissingChunks ? '' : assembly.chunks.join('');
					if (hasMissingChunks || (assembly.totalSize > 0 && joined.length !== assembly.totalSize)) {
						console.error(`[Synqra] incomplete or corrupted chunk transfer for ${op.path}, discarding`);
						break;
					}

					const exists = this.vault.getAbstractFileByPath(op.path);
					if (assembly.binary) {
						const binaryData = base64ToArrayBuffer(joined);
						if (exists && exists instanceof TFile) {
							await this.vault.modifyBinary(exists, binaryData);
						} else {
							const parentDir = op.path.substring(0, op.path.lastIndexOf('/'));
							if (parentDir) await ensureFolder(this.vault, parentDir);
							await this.vault.createBinary(op.path, binaryData);
						}
					} else {
						if (exists && exists instanceof TFile) {
							await this.vault.modify(exists, joined);
						} else {
							const parentDir = op.path.substring(0, op.path.lastIndexOf('/'));
							if (parentDir) await ensureFolder(this.vault, parentDir);
							await this.vault.create(op.path, joined);
						}
					}
					const target = this.vault.getAbstractFileByPath(op.path);
					if (target instanceof TFile) {
						const canonical = toCanonicalPath(op.path);
						if (assembly.binary) {
							void this.manifestManager?.updateFile(target, base64ToArrayBuffer(joined));
						} else {
							void this.manifestManager?.updateFile(target, joined);
							void this.backgroundSync?.onFileAdded(canonical);
						}
					}
					break;
				}
				case 'folder-create': {
					await ensureFolder(this.vault, op.path);
					const canonical = toCanonicalPath(op.path);
					this.manifestManager?.addFolder(canonical);
					break;
				}
			}
		} catch (err) {
			console.error(`[Synqra] failed to apply remote op ${op.type}:`, err);
		} finally {
			window.setTimeout(() => {
				for (const path of paths) this.unmutePathEvents(path);
			}, VAULT_EVENT_SETTLE_MS);
		}
	}

	async onFileCreate(file: TFile | { path: string }) {
		const localPath = normalizePath(file.path);
		if (this.isPathMuted(localPath) || !this.sendOp) return;
		const wirePath = toCanonicalPath(localPath);
		if (!(file instanceof TFile)) {
			this.sendOp({ type: 'folder-create', path: wirePath });
			return;
		}
		const prev = this.sendQueues.get(localPath) ?? Promise.resolve();
		const binary = !isTextFile(file.path);
		const tfile = file;
		const task = prev.then(async () => {
			if (!this.sendOp) return;
			try {
				if (binary) {
					const binaryContent = await this.vault.readBinary(tfile);
					if (this.isPathMuted(localPath)) return;
					if (binaryContent.byteLength > MAX_FILE_SIZE) return;
					await this.sendFileContent(wirePath, arrayBufferToBase64(binaryContent), true);
				} else {
					const content = normalizeLineEndings(await this.vault.read(tfile));
					if (this.isPathMuted(localPath)) return;
					if (content.length > MAX_FILE_SIZE) return;
					await this.sendFileContent(wirePath, content, false);
				}
			} catch {
				new Notice(`[Synqra] failed to sync ${localPath}`);
			}
		});
		this.sendQueues.set(localPath, task);
		await task;
		if (this.sendQueues.get(localPath) === task) this.sendQueues.delete(localPath);
	}

	async onFileModify(file: TFile) {
		const localPath = normalizePath(file.path);
		if (this.isPathMuted(localPath) || !this.sendOp) return;
		const binary = !isTextFile(file.path);
		if (!binary) return;
		const wirePath = toCanonicalPath(localPath);
		const prev = this.sendQueues.get(localPath) ?? Promise.resolve();
		const task = prev.then(async () => {
			if (!this.sendOp) return;
			try {
				const binaryContent = await this.vault.readBinary(file);
				if (this.isPathMuted(localPath)) return;
				if (binaryContent.byteLength > MAX_FILE_SIZE) return;
				const content = arrayBufferToBase64(binaryContent);
				await this.sendFileContent(wirePath, content, true);
			} catch {
				new Notice(`[Synqra] failed to sync ${localPath}`);
			}
		});
		this.sendQueues.set(localPath, task);
		await task;
		if (this.sendQueues.get(localPath) === task) this.sendQueues.delete(localPath);
	}

	onFileDelete(path: string, force = false) {
		const localPath = normalizePath(path);
		if (!force && this.isPathMuted(localPath)) return;
		if (!this.sendOp) return;
		const wirePath = toCanonicalPath(localPath);
		this.sendOp({ type: 'delete', path: wirePath });
	}

	onFileRename(oldPath: string, newPath: string) {
		const localOld = normalizePath(oldPath);
		const localNew = normalizePath(newPath);
		if (this.isPathMuted(localOld) || this.isPathMuted(localNew) || !this.sendOp) return;
		this.sendOp({
			type: 'rename',
			oldPath: toCanonicalPath(localOld),
			newPath: toCanonicalPath(localNew),
		});
	}

	private async sendFileContent(path: string, content: string, binary: boolean): Promise<void> {
		if (!this.sendOp) return;
		if (content.length > CHUNK_SIZE) {
			const transferId = Math.random().toString(36).substring(2);
			const totalChunks = Math.ceil(content.length / CHUNK_SIZE);
			this.sendOp(
				binary
					? { type: 'chunk-start', path, totalSize: content.length, binary: true, transferId }
					: { type: 'chunk-start', path, totalSize: content.length, transferId },
			);
			for (let i = 0; i < totalChunks; i++) {
				const chunk = content.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
				this.sendOp({ type: 'chunk-data', path, index: i, data: chunk, transferId });
				await new Promise((r) => window.setTimeout(r, 15));
			}
			this.sendOp({ type: 'chunk-end', path, transferId });
		} else {
			this.sendOp(
				binary
					? { type: 'create', path, content, binary: true }
					: { type: 'create', path, content },
			);
		}
	}
}
