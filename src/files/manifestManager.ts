import { FileManager, Notice, requestUrl, TFolder, TFile, type Vault, type Workspace } from 'obsidian';
import type * as Y from 'yjs';
import type { DocHandle, SyncManager } from '../syncManager';
import type { FileEntry } from '../types';
import {
	VAULT_EVENT_SETTLE_MS,
	ensureFolder,
	getFileByPath,
	isTextFile,
	normalizeLineEndings,
	normalizePath,
	toCanonicalPath,
	toHttpUrl,
	toLocalPath,
} from '../utils';
import type { ExclusionManager } from './exclusionManager';
import type { FileOpsManager } from './fileOpsManager';

async function hashBuffer(buf: BufferSource): Promise<string> {
	const hash = await crypto.subtle.digest('SHA-256', buf);
	return Array.from(new Uint8Array(hash))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

function hashContent(content: string): Promise<string> {
	return hashBuffer(new TextEncoder().encode(content));
}

export class ManifestManager {
	private syncManager: SyncManager | null = null;
	private fileOpsManager: FileOpsManager | null = null;
	private docHandle: DocHandle | null = null;
	private manifest: Y.Map<FileEntry> | null = null;
	private observer: ((events: Y.YMapEvent<FileEntry>) => void) | null = null;

	constructor(
		private readonly vault: Vault,
		private readonly exclusionManager: ExclusionManager,
		private readonly fileManager?: FileManager,
	) {}

	setFileOpsManager(fileOpsManager: FileOpsManager): void {
		this.fileOpsManager = fileOpsManager;
	}

	async connect(syncManager: SyncManager): Promise<void> {
		this.syncManager = syncManager;
		this.docHandle = syncManager.getDoc('__manifest__');
		if (!this.docHandle) return;
		this.manifest = this.docHandle.doc.getMap('files');
		await syncManager.waitForSync('__manifest__');
	}

	async publishManifest(): Promise<void> {
		if (!this.manifest || !this.docHandle) return;

		const files = this.getSharedFiles();
		const entries = new Map<string, FileEntry>();

		for (const file of files) {
			try {
				const binary = !isTextFile(file.path);
				const canonicalPath = toCanonicalPath(normalizePath(file.path));
				if (binary) {
					const binaryContent = await this.vault.readBinary(file);
					entries.set(canonicalPath, {
						hash: await hashBuffer(binaryContent),
						size: file.stat.size,
						mtime: file.stat.mtime,
						binary: true,
					});
				} else {
					const content = normalizeLineEndings(await this.vault.read(file));
					entries.set(canonicalPath, {
						hash: await hashContent(content),
						size: content.length,
						mtime: file.stat.mtime,
					});
				}
			} catch {
				new Notice(`[Synqra] failed to read ${file.path}, skipping`);
			}
		}

		for (const item of this.vault.getAllLoadedFiles()) {
			if (!(item instanceof TFolder)) continue;
			if (!item.path || item.path === '/') continue;
			if (!this.isSharedPath(item.path)) continue;
			if (item.children.length > 0) continue;
			entries.set(toCanonicalPath(normalizePath(item.path)), {
				hash: '',
				size: 0,
				mtime: 0,
				directory: true,
			});
		}

		this.docHandle.doc.transact(() => {
			for (const [filePath, fileEntry] of entries) {
				const existing = this.manifest?.get(filePath);
				if (existing && existing.hash === fileEntry.hash) continue;
				this.manifest?.set(filePath, fileEntry);
			}

			if (this.manifest) {
				for (const key of Array.from(this.manifest.keys())) {
					if (!entries.has(key) && this.isSharedPath(key)) {
						this.manifest.delete(key);
					}
				}
			}
		});
	}

	size(): number {
		return this.manifest?.size ?? 0;
	}

	async purgeUnmatchedLocalFiles(
		workspace?: Workspace,
		mute?: (path: string) => void,
		unmute?: (path: string) => void,
	): Promise<number> {
		if (!this.manifest || this.manifest.size === 0) return 0;
		const entries = new Set(this.manifest.keys());
		const entriesList = Array.from(entries);
		const folderHasManifestFiles = (canonicalFolder: string) => {
			const folderPrefix = canonicalFolder.endsWith('/') ? canonicalFolder : canonicalFolder + '/';
			return entriesList.some((e) => e.startsWith(folderPrefix));
		};
		let purged = 0;

		const allLocal = this.vault.getAllLoadedFiles();

		// Detach all workspace leaves for any unmatched files/folders first
		if (workspace) {
			for (const item of allLocal) {
				if (!item.path || item.path === '/') continue;
				if (!this.isSharedPath(item.path)) continue;
				const canonical = toCanonicalPath(normalizePath(item.path));
				if (!entries.has(canonical)) {
					if (item instanceof TFolder && folderHasManifestFiles(canonical)) {
						continue;
					}
					const prefix = item.path.endsWith('/') ? item.path : item.path + '/';
					workspace.iterateAllLeaves((leaf) => {
						const view = leaf.view as { file?: { path: string } };
						const p = view?.file?.path;
						if (p && (p === item.path || p.startsWith(prefix))) {
							leaf.detach();
						}
					});
				}
			}
		}

		// Separate files and folders to delete files first
		const filesToPurge: TFile[] = [];
		const foldersToPurge: TFolder[] = [];

		for (const item of allLocal) {
			if (!item.path || item.path === '/') continue;
			if (!this.isSharedPath(item.path)) continue;
			const canonical = toCanonicalPath(normalizePath(item.path));
			if (!entries.has(canonical)) {
				if (item instanceof TFolder) {
					if (!folderHasManifestFiles(canonical)) {
						foldersToPurge.push(item);
					}
				} else if (item instanceof TFile) {
					filesToPurge.push(item);
				}
			}
		}

		for (const item of filesToPurge) {
			mute?.(item.path);
			try {
				if (this.fileManager) {
					await this.fileManager.trashFile(item);
				}
				purged++;
			} catch {
				// Ignore file delete error if already removed
			} finally {
				if (unmute) window.setTimeout(() => unmute(item.path), VAULT_EVENT_SETTLE_MS * 2);
			}
		}

		for (const item of foldersToPurge) {
			mute?.(item.path);
			try {
				if (this.fileManager) {
					await this.fileManager.trashFile(item);
				}
				purged++;
			} catch {
				// Ignore folder delete error if already removed
			} finally {
				if (unmute) window.setTimeout(() => unmute(item.path), VAULT_EVENT_SETTLE_MS * 2);
			}
		}

		return purged;
	}

	async downloadBinaryFile(
		path: string,
		serverUrl: string,
		roomId: string,
		serverPassword?: string,
		mute?: (path: string) => void,
		unmute?: (path: string) => void,
	): Promise<boolean> {
		if (!this.manifest) return false;
		const entry = this.manifest.get(path);
		if (!entry || !entry.binary) return false;

		const diskPath = toLocalPath(path);
		const localFile = getFileByPath(this.vault, diskPath);
		if (localFile) {
			try {
				const localHash = await hashBuffer(await this.vault.readBinary(localFile));
				if (localHash === entry.hash) return true;
			} catch {
				// Ignore read error and re-download
			}
		}

		try {
			const httpUrl = toHttpUrl(serverUrl);
			const sep = httpUrl.endsWith('/') ? '' : '/';
			const passParam = serverPassword ? `?password=${encodeURIComponent(serverPassword)}` : '';
			const encodedPath = path.split('/').map(encodeURIComponent).join('/');
			const fileUrl = `${httpUrl}${sep}file/${encodeURIComponent(roomId)}/${encodedPath}${passParam}`;
			const res = await requestUrl({ url: fileUrl, throw: false });
			if (res.status === 200) {
				const arrayBuf = res.arrayBuffer;
				const parentDir = diskPath.substring(0, diskPath.lastIndexOf('/'));
				if (parentDir) await ensureFolder(this.vault, parentDir);

				mute?.(diskPath);
				try {
					if (localFile) {
						await this.vault.modifyBinary(localFile, arrayBuf);
					} else {
						await this.vault.createBinary(diskPath, arrayBuf);
					}
				} finally {
					if (unmute) window.setTimeout(() => unmute(diskPath), VAULT_EVENT_SETTLE_MS);
				}
				return true;
			}
		} catch {
			// Binary download failed
		}
		return false;
	}

	async syncFromManifest(
		serverUrl: string,
		roomId: string,
		mute?: (path: string) => void,
		unmute?: (path: string) => void,
		serverPassword?: string,
	): Promise<number> {
		if (!this.manifest || !this.syncManager) return 0;

		let synced = 0;
		const entries = Array.from(this.manifest.entries());

		for (const [path, entry] of entries) {
			if (!path || path.startsWith('/') || path.startsWith('\\')) continue;
			const diskPath = toLocalPath(path);
			const localFile = getFileByPath(this.vault, diskPath);

			if (entry.directory) {
				const existing = this.vault.getAbstractFileByPath(diskPath);
				if (!existing) {
					await ensureFolder(this.vault, diskPath);
					synced++;
				}
				continue;
			}

			let needsSync = true;
			if (localFile) {
				const localHash = entry.binary
					? await hashBuffer(await this.vault.readBinary(localFile))
					: await hashContent(normalizeLineEndings(await this.vault.read(localFile)));
				if (localHash === entry.hash) {
					needsSync = false;
				}
			}

			if (!needsSync) continue;

			if (entry.binary) {
				const ok = await this.downloadBinaryFile(path, serverUrl, roomId, serverPassword, mute, unmute);
				if (ok) synced++;
				continue;
			}

			const tempHandle = this.syncManager?.getDoc(path);
			if (!tempHandle) continue;

			try {
				await this.syncManager.waitForSync(path);
				const content = tempHandle.text.toString();
				const parentDir = diskPath.substring(0, diskPath.lastIndexOf('/'));
				if (parentDir) await ensureFolder(this.vault, parentDir);

				mute?.(diskPath);
				try {
					if (localFile) {
						await this.vault.modify(localFile, content);
					} else {
						await this.vault.create(diskPath, content);
					}
				} finally {
					if (unmute) {
						window.setTimeout(() => unmute(diskPath), VAULT_EVENT_SETTLE_MS);
					}
				}
				synced++;
			} catch {
				// Failed individual file sync
			}
		}

		return synced;
	}

	setManifestChangeHandler(
		callback: (added: string[], removed: string[], updated: string[]) => void,
	): void {
		if (!this.manifest) return;
		if (this.observer) this.manifest.unobserve(this.observer);

		this.observer = (event: Y.YMapEvent<FileEntry>) => {
			const added: string[] = [];
			const removed: string[] = [];
			const updated: string[] = [];
			event.changes.keys.forEach((change, key) => {
				if (change.action === 'add') added.push(key);
				else if (change.action === 'delete') removed.push(key);
				else if (change.action === 'update') updated.push(key);
			});
			if (added.length > 0 || removed.length > 0 || updated.length > 0) {
				callback(added, removed, updated);
			}
		};
		this.manifest.observe(this.observer);
	}

	async updateFile(file: TFile, content: string | ArrayBuffer): Promise<void> {
		if (!this.manifest || !this.isSharedPath(file.path)) return;
		const canonical = toCanonicalPath(normalizePath(file.path));

		if (content instanceof ArrayBuffer) {
			this.manifest.set(canonical, {
				hash: await hashBuffer(content),
				size: content.byteLength,
				mtime: file.stat.mtime,
				binary: true,
			});
		} else {
			const normalized = normalizeLineEndings(content);
			this.manifest.set(canonical, {
				hash: await hashContent(normalized),
				size: normalized.length,
				mtime: file.stat.mtime,
			});
		}
	}

	removeFile(path: string): void {
		if (!this.manifest) return;
		const canonical = toCanonicalPath(normalizePath(path));
		const prefix = canonical + '/';
		
		this.docHandle?.doc.transact(() => {
			this.manifest?.delete(canonical);
			if (this.manifest) {
				for (const key of this.manifest.keys()) {
					if (key.startsWith(prefix)) {
						this.manifest.delete(key);
					}
				}
			}
		});
	}

	hasFile(rawPath: string): boolean {
		if (!this.manifest) return false;
		return this.manifest.has(toCanonicalPath(normalizePath(rawPath)));
	}

	addFolder(rawPath: string): void {
		if (!this.manifest || !this.isSharedPath(rawPath)) return;
		const path = toCanonicalPath(normalizePath(rawPath));
		if (this.manifest.has(path)) return;
		this.manifest.set(path, { hash: '', size: 0, mtime: 0, directory: true });
	}

	renameFile(oldPath: string, newPath: string, syncManager?: SyncManager): void {
		if (!this.manifest || !this.docHandle) return;
		const normOld = toCanonicalPath(normalizePath(oldPath));
		const normNew = toCanonicalPath(normalizePath(newPath));
		const oldPrefix = normOld + '/';
		const newPrefix = normNew + '/';
		const nestedOldKeys: string[] = [];

		this.docHandle.doc.transact(() => {
			const fileEntry = this.manifest?.get(normOld);
			if (fileEntry) {
				this.manifest?.delete(normOld);
				this.manifest?.set(normNew, fileEntry);
			}

			// Rename any nested files/folders if this was a directory
			if (this.manifest) {
				const nestedToRename: [string, string, FileEntry][] = [];
				for (const [key, entry] of this.manifest.entries()) {
					if (key.startsWith(oldPrefix)) {
						const suffix = key.slice(oldPrefix.length);
						nestedToRename.push([key, newPrefix + suffix, entry]);
						nestedOldKeys.push(key);
					}
				}
				for (const [oldKey, newKey, entry] of nestedToRename) {
					this.manifest.delete(oldKey);
					this.manifest.set(newKey, entry);
				}
			}
		});

		if (syncManager) {
			syncManager.releaseDoc(normOld);
			for (const oldKey of nestedOldKeys) {
				syncManager.releaseDoc(oldKey);
			}
		}
	}

	getEntries(): Map<string, FileEntry> {
		if (!this.manifest) return new Map();
		return new Map(this.manifest.entries());
	}

	isSharedPath(rawPath: string): boolean {
		const path = toCanonicalPath(normalizePath(rawPath));
		return !this.exclusionManager.isExcluded(path);
	}

	destroy(): void {
		if (this.observer && this.manifest) {
			this.manifest.unobserve(this.observer);
			this.observer = null;
		}
		if (this.syncManager) {
			this.syncManager.releaseDoc('__manifest__');
		}
		this.docHandle = null;
		this.manifest = null;
		this.syncManager = null;
	}

	private getSharedFiles(): TFile[] {
		return this.vault.getFiles().filter((file) => this.isSharedPath(file.path));
	}
}
