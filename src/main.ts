import { Notice, Plugin, normalizePath } from 'obsidian';
import { CollabSettingTab } from './settings';
import { DEFAULT_SETTINGS, getRandomPresetColor, getRandomUsername, type CollabSettings, type ConnectionStatus } from './types';
import { SyncManager } from './syncManager';
import { ControlChannel } from './sync/controlChannel';
import { ExclusionManager } from './files/exclusionManager';
import { FileOpsManager } from './files/fileOpsManager';
import { ManifestManager } from './files/manifestManager';
import { BackgroundSync } from './files/backgroundSync';
import { EditorBinding } from './editorBinding';
import { ExcalidrawBinding } from './editor/excalidrawBinding';
import { PresenceManager } from './session/presenceManager';
import { registerVaultEvents } from './files/vaultEvents';
import { isTextFile, toLocalPath } from './utils';

export default class CollabPlugin extends Plugin {
	settings!: CollabSettings;
	syncManager!: SyncManager;
	controlChannel!: ControlChannel;
	exclusionManager!: ExclusionManager;
	fileOpsManager!: FileOpsManager;
	manifestManager!: ManifestManager;
	backgroundSync!: BackgroundSync;
	editorBinding!: EditorBinding;
	excalidrawBinding!: ExcalidrawBinding;
	presenceManager!: PresenceManager;

	private statusBar: HTMLElement | null = null;
	private currentStatus: ConnectionStatus = 'disconnected';

	async onload(): Promise<void> {
		await this.loadSettings();

		this.syncManager = new SyncManager(() => ({
			serverUrl: this.settings.serverUrl,
			serverPassword: this.settings.serverPassword,
			displayName: this.settings.displayName,
			roomId: this.settings.roomId,
		}));

		this.controlChannel = new ControlChannel(() => this.settings);

		this.exclusionManager = new ExclusionManager(this.app.vault, () => this.settings.sharedFolder);
		this.fileOpsManager = new FileOpsManager(this.app, this.app.vault, this.app.fileManager);
		this.manifestManager = new ManifestManager(this.app.vault, this.exclusionManager, this.app.fileManager);
		this.backgroundSync = new BackgroundSync(
			this.app.vault,
			this.syncManager,
			this.manifestManager,
			this.fileOpsManager,
		);
		this.fileOpsManager.setSyncDependencies(this.manifestManager, this.backgroundSync);
		this.manifestManager.setFileOpsManager(this.fileOpsManager);
		this.editorBinding = new EditorBinding(
			this.app,
			this.syncManager,
			(path) => this.manifestManager.hasFile(path),
		);
		this.excalidrawBinding = new ExcalidrawBinding(
			this.app,
			this.syncManager,
			(path) => this.manifestManager.hasFile(path),
		);
		this.excalidrawBinding.setManifestManager(this.manifestManager);
		this.fileOpsManager.setEditorBindings(this.editorBinding, this.excalidrawBinding);
		this.presenceManager = new PresenceManager(
			this.app,
			this.controlChannel,
			this.syncManager,
			() => this.settings.displayName,
		);

		// Wire control channel file ops
		this.fileOpsManager.setSender((op) => {
			this.controlChannel.send({ type: 'file-op', op });
		});
		this.fileOpsManager.setActiveFileRenameHandler((oldPath, newPath) => {
			const active = this.app.workspace.getActiveFile();
			if (!active) return;
			const oldNorm = normalizePath(oldPath);
			const newNorm = normalizePath(newPath);
			const activeNorm = normalizePath(active.path);
			if (
				activeNorm === oldNorm ||
				activeNorm === newNorm ||
				activeNorm.startsWith(oldNorm + '/') ||
				activeNorm.startsWith(newNorm + '/')
			) {
				this.onActiveFileChange();
			}
		});

		this.controlChannel.onMessage((msg) => {
			void (async () => {
				if (msg.type === 'file-op') {
					await this.fileOpsManager.applyRemoteOp(msg.op);
				} else if (msg.type === 'room-deleted') {
					new Notice(`[Synqra] ${msg.message || 'Room was deleted by an admin'}`);
					this.disconnect();
				}
			})();
		});

		// Register CM6 base extension
		this.registerEditorExtension(this.editorBinding.getBaseExtension());

		// Sync status updates
		this.syncManager.onStatus = (status: ConnectionStatus) => {
			this.currentStatus = status;
			this.updateStatusBar();
			if (status === 'connected') {
				void this.onConnected();
			}
		};

		this.controlChannel.onStatusChange = (status) => {
			if (status === 'connected') {
				this.presenceManager.broadcastPresence();
			}
		};

		// Vault and workspace event listeners
		registerVaultEvents(this);

		// Commands
		this.addCommand({
			id: 'connect',
			name: 'Connect to collaboration room',
			callback: () => this.connect(),
		});
		this.addCommand({
			id: 'disconnect',
			name: 'Disconnect from collaboration room',
			callback: () => this.disconnect(),
		});
		this.addCommand({
			id: 'reconnect',
			name: 'Reconnect to collaboration room',
			callback: () => this.scheduleReconnect(),
		});


		// Settings tab
		this.addSettingTab(new CollabSettingTab(this.app, this));

		// Status bar
		this.statusBar = this.addStatusBarItem();
		this.updateStatusBar();

		if (this.settings.autoConnect) {
			void this.connect();
		}
	}

	onunload(): void {
		const activeFile = this.app.workspace.getActiveFile();
		if (activeFile && isTextFile(activeFile.path)) {
			const docHandle = this.syncManager.getDoc(activeFile.path);
			if (docHandle) {
				const content = docHandle.text.toString();
				if (content) {
					void this.app.vault.adapter.write(toLocalPath(activeFile.path), content);
				}
			}
		}
		this.excalidrawBinding.destroy();
		this.editorBinding.destroy();
		this.backgroundSync.destroy();
		this.manifestManager.destroy();
		this.fileOpsManager.destroy();
		this.presenceManager.destroy();
		this.controlChannel.destroy();
		this.syncManager.disconnect();
	}

	connect(): void {
		void this.syncManager.connect();
		this.controlChannel.connect();
	}

	disconnect(): void {
		this.editorBinding.unbind();
		this.excalidrawBinding.unbind();
		this.backgroundSync.destroy();
		this.manifestManager.destroy();
		this.presenceManager.reset();
		this.syncManager.disconnect();
		this.controlChannel.disconnect();
	}

	scheduleReconnect(): void {
		this.disconnect();
		this.connect();
	}

	async publishManifest(): Promise<void> {
		if (this.currentStatus !== 'connected') {
			new Notice('[Synqra] please connect to room first');
			return;
		}
		await this.manifestManager.publishManifest();
		new Notice('[Synqra] vault manifest published');
	}

	onActiveFileChange(): void {
		const activeFile = this.app.workspace.getActiveFile();
		this.backgroundSync.setActiveFile(activeFile?.path ?? null);
		void (async () => {
			const cursorUser = {
				name: this.settings.displayName,
				color: this.settings.cursorColor,
			};

			const excalidrawBound = await this.excalidrawBinding.activateForFile(activeFile, cursorUser);
			if (excalidrawBound) {
				this.backgroundSync.setCollabBoundFile(activeFile?.path ?? null);
				return;
			}

			const editorBound = await this.editorBinding.activateForFile(activeFile, cursorUser);
			if (editorBound) {
				this.backgroundSync.setCollabBoundFile(activeFile?.path ?? null);
			} else {
				this.backgroundSync.setCollabBoundFile(null);
			}
		})();
	}

	async loadSettings(): Promise<void> {
		const raw = (await this.loadData()) as Partial<CollabSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);

		let needsSave = false;
		if (!raw || !raw.displayName || raw.displayName === 'Anonymous') {
			this.settings.displayName = getRandomUsername();
			needsSave = true;
		}
		if (!raw || !raw.cursorColor) {
			this.settings.cursorColor = getRandomPresetColor();
			needsSave = true;
		}

		if (needsSave) {
			await this.saveSettings();
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	isConnected(): boolean {
		return this.currentStatus === 'connected';
	}

	private async onConnected(): Promise<void> {
		try {
			await this.manifestManager.connect(this.syncManager);
			this.onActiveFileChange();
			if (this.manifestManager.size() === 0) {
				// Room has no manifest on server yet; publish local shared files to initialize room safely
				await this.manifestManager.publishManifest();
			} else {
				const purgedCount = await this.manifestManager.purgeUnmatchedLocalFiles(
					this.app.workspace,
					(path: string) => this.fileOpsManager.mutePathEvents(path),
					(path: string) => this.fileOpsManager.unmutePathEvents(path),
				);
				if (purgedCount > 0) {
					new Notice(`[Synqra] Moved ${purgedCount} unmatched local file(s) to trash.`, 6000);
				}
				await this.manifestManager.syncFromManifest(
					this.settings.serverUrl,
					this.settings.roomId,
					(path) => this.fileOpsManager.mutePathEvents(path),
					(path) => this.fileOpsManager.unmutePathEvents(path),
					this.settings.serverPassword,
				);
			}
			await this.backgroundSync.startAll();
			this.onActiveFileChange();
		} catch (err) {
			console.error('[Synqra] error during connect init:', err);
		}
	}

	private updateStatusBar(): void {
		if (!this.statusBar) return;
		const statusText =
			this.currentStatus === 'connected'
				? `Collab: on`
				: this.currentStatus === 'connecting'
					? 'Collab: connecting…'
					: 'Collab: off';
		this.statusBar.setText(statusText);
	}
}

export type { CollabSettings };