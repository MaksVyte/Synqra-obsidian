import { Notice, type TAbstractFile, TFile } from 'obsidian';
import type CollabPlugin from '../main';
import { VAULT_EVENT_SETTLE_MS, isTextFile } from '../utils';

export function registerVaultEvents(plugin: CollabPlugin): void {
	let pendingRename: Promise<void> | null = null;
	const renamedPaths = new Set<string>();

	const onActiveChange = () => {
		const run = () => {
			plugin.onActiveFileChange();
			plugin.presenceManager.debouncedBroadcastPresence();
		};
		if (pendingRename) {
			void pendingRename.then(run);
		} else {
			run();
		}
	};

	plugin.registerEvent(plugin.app.workspace.on('active-leaf-change', onActiveChange));
	plugin.registerEvent(plugin.app.workspace.on('file-open', onActiveChange));
	plugin.registerEvent(plugin.app.workspace.on('layout-change', onActiveChange));

	plugin.registerEvent(
		plugin.app.vault.on('create', (file: TAbstractFile) => {
			if (!plugin.isConnected()) return;
			const originalPath = file.path;
			if (!plugin.manifestManager.isSharedPath(originalPath)) return;
			if (renamedPaths.has(originalPath)) return;
			if (plugin.fileOpsManager.isPathMuted(originalPath)) return;

			void plugin.fileOpsManager.onFileCreate(file);

			if (file instanceof TFile) {
				void (async () => {
					try {
						if (plugin.fileOpsManager.isPathMuted(originalPath)) return;
						const content = isTextFile(originalPath)
							? await plugin.app.vault.read(file)
							: await plugin.app.vault.readBinary(file);
						if (renamedPaths.has(originalPath)) return;
						if (plugin.fileOpsManager.isPathMuted(originalPath)) return;
						if (isTextFile(originalPath)) {
							await plugin.backgroundSync.onFileAdded(originalPath);
						}
						if (renamedPaths.has(originalPath)) return;
						if (plugin.fileOpsManager.isPathMuted(originalPath)) return;
						await plugin.manifestManager.updateFile(file, content);
					} catch {
						if (!renamedPaths.has(originalPath)) {
							new Notice(`[Synqra] failed to update manifest for ${originalPath}`);
						}
					}
				})();
			} else {
				plugin.manifestManager.addFolder(originalPath);
			}
		}),
	);

	plugin.registerEvent(
		plugin.app.vault.on('delete', (file: TAbstractFile) => {
			if (!plugin.isConnected()) return;
			if (!plugin.manifestManager.isSharedPath(file.path)) return;
			if (plugin.fileOpsManager.isPathMuted(file.path)) return;

			// Send delete op to server and peers immediately before muting
			plugin.fileOpsManager.onFileDelete(file.path, true);
			plugin.backgroundSync.onFileRemoved(file.path);
			plugin.manifestManager.removeFile(file.path);

			// Mute path events locally to prevent view tear-down from resurrecting file
			plugin.fileOpsManager.mutePathEvents(file.path);

			const run = async () => {
				if (plugin.editorBinding.getCurrentPath() === file.path) {
					plugin.editorBinding.unbind();
				}
				if (plugin.excalidrawBinding.getCurrentPath() === file.path) {
					plugin.excalidrawBinding.unbind(true);
				}

				const active = plugin.app.workspace.getActiveFile();
				if (active && active.path === file.path) {
					plugin.backgroundSync.setActiveFile(null);
					plugin.backgroundSync.setCollabBoundFile(null);
				}

				// Detach any open leaves for this file or sub-files if folder to prevent resurrection
				const prefix = file.path.endsWith('/') ? file.path : file.path + '/';
				plugin.app.workspace.iterateAllLeaves((leaf) => {
					const view = leaf.view as { file?: { path: string } };
					const p = view?.file?.path;
					if (p && (p === file.path || p.startsWith(prefix))) {
						void leaf.setViewState({ type: 'empty' });
						leaf.detach();
					}
				});

				// Verify file is not resurrected on disk by editor flush
				const lingering = plugin.app.vault.getAbstractFileByPath(file.path);
				if (lingering) {
					try {
						await plugin.app.fileManager.trashFile(lingering);
					} catch {
						try {
							await plugin.app.vault.adapter.remove(file.path);
						} catch {
							// Ignore
						}
					}
				}
			};

			try {
				if (pendingRename) {
					void pendingRename.then(run);
				} else {
					void run();
				}
			} finally {
				window.setTimeout(() => {
					plugin.fileOpsManager.unmutePathEvents(file.path);
				}, VAULT_EVENT_SETTLE_MS);
			}
		}),
	);

	plugin.registerEvent(
		plugin.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
			if (!plugin.isConnected()) return;
			if (plugin.fileOpsManager.isPathMuted(file.path) || plugin.fileOpsManager.isPathMuted(oldPath)) return;

			const oldShared = plugin.manifestManager.isSharedPath(oldPath);
			const newShared = plugin.manifestManager.isSharedPath(file.path);

			if (!oldShared && !newShared) return;

			// If moved from unshared/trash into shared vault: treat as create
			if (!oldShared && newShared) {
				if (file instanceof TFile) {
					void plugin.fileOpsManager.onFileCreate(file);
					void (async () => {
						try {
							const content = isTextFile(file.path)
								? await plugin.app.vault.read(file)
								: await plugin.app.vault.readBinary(file);
							if (isTextFile(file.path)) {
								await plugin.backgroundSync.onFileAdded(file.path);
							}
							await plugin.manifestManager.updateFile(file, content);
						} catch {
							// Ignore read/update error on moved file
						}
					})();
				}
				return;
			}

			// If moved from shared vault into unshared/trash: treat as delete
			if (oldShared && !newShared) {
				plugin.backgroundSync.onFileRemoved(oldPath);
				plugin.manifestManager.removeFile(oldPath);
				plugin.fileOpsManager.onFileDelete(oldPath);
				return;
			}

			// Both are shared paths: normal rename
			renamedPaths.add(oldPath);

			const prev = (pendingRename ?? Promise.resolve()).catch(() => {});
			const task = prev.then(async () => {
				plugin.fileOpsManager.onFileRename(oldPath, file.path);
				await plugin.backgroundSync.onFileRenamed(oldPath, file.path);
				plugin.manifestManager.renameFile(oldPath, file.path, plugin.syncManager);

				const activeFile = plugin.app.workspace.getActiveFile();
				if (
					activeFile &&
					(activeFile.path === file.path ||
						activeFile.path === oldPath ||
						activeFile.path.startsWith(oldPath + '/') ||
						activeFile.path.startsWith(file.path + '/'))
				) {
					plugin.onActiveFileChange();
				}
			});
			pendingRename = task.finally(() => {
				if (pendingRename === task) pendingRename = null;
				renamedPaths.delete(oldPath);
			});
		}),
	);

	plugin.registerEvent(
		plugin.app.vault.on('modify', (file: TAbstractFile) => {
			if (!plugin.isConnected()) return;
			if (!(file instanceof TFile) || !plugin.manifestManager.isSharedPath(file.path)) return;
			if (plugin.fileOpsManager.isPathMuted(file.path)) return;
			if (!plugin.manifestManager.hasFile(file.path)) return;

			if (isTextFile(file.path)) {
				if (plugin.backgroundSync.isRecentDiskWrite(file.path)) return;
				void plugin.backgroundSync.handleLocalTextModify(file.path);
				return;
			}
			
			void plugin.fileOpsManager.onFileModify(file);
			void (async () => {
				try {
					const buf = await plugin.app.vault.readBinary(file);
					await plugin.manifestManager.updateFile(file, buf);
				} catch {
					new Notice(`[Synqra] failed to update manifest for ${file.path}`);
				}
			})();
		}),
	);
}
