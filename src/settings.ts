import { App, Modal, Notice, PluginSettingTab, requestUrl, Setting } from 'obsidian';
import type CollabPlugin from './main';
import {
	DEFAULT_SETTINGS,
	getRandomPresetColor,
	getRandomUsername,
	type CollabSettings,
	type RoomInfo,
} from './types';
import { toHttpUrl } from './utils';

class ConfirmDeleteModal extends Modal {
	constructor(app: App, private roomId: string, private onConfirm: () => Promise<void>) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		new Setting(contentEl).setName(`Delete room '${this.roomId}'?`).setHeading();
		contentEl.createEl('p', {
			text: `Are you sure you want to delete room '${this.roomId}' from the server? All notes, history, and files in this room will be permanently erased.`,
		});

		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText('Cancel').onClick(() => {
					this.close();
				}),
			)
			.addButton((btn) =>
				btn
					.setButtonText('Delete permanently')
					.setWarning()
					.onClick(async () => {
						this.close();
						await this.onConfirm();
					}),
			);
	}

	onClose() {
		this.contentEl.empty();
	}
}

export class CollabSettingTab extends PluginSettingTab {
	plugin: CollabPlugin;
	private draftSettings: CollabSettings | null = null;
	private isAdminUnlocked = false;
	private adminRooms: RoomInfo[] = [];
	private isLoadingRooms = false;
	private newRoomId = '';
	private newRoomDesc = '';

	// Server rooms state
	private serverRooms: RoomInfo[] = [];
	private isLoadingServerRooms = false;
	private roomsContainerEl: HTMLElement | null = null;
	private isRoomsExpanded = false;
	private pollTimer: number | null = null;

	constructor(app: App, plugin: CollabPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	override hide(): void {
		super.hide();
		if (this.pollTimer !== null) {
			window.clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
		if (this.plugin.onStatusChange) {
			this.plugin.onStatusChange = undefined;
		}
		this.draftSettings = null;
		this.roomsContainerEl = null;
	}

	getSettingDefinitions(): unknown[] {
		return [];
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		if (!this.draftSettings) {
			this.draftSettings = Object.assign({}, this.plugin.settings);
		}
		const draft = this.draftSettings;

		this.plugin.onStatusChange = () => {
			this.renderRoomsList();
		};

		// Start background room polling every 4 seconds
		if (this.pollTimer === null) {
			this.pollTimer = window.setInterval(() => {
				void this.fetchServerRooms(true);
			}, 4000);
		}
		void this.fetchServerRooms(true);

		new Setting(containerEl).setName('Connection').setHeading();

		// Warning banner
		const banner = containerEl.createDiv({ cls: 'synqra-warning' });
		banner.createDiv({ cls: 'synqra-warning-title', text: '⚠️ Shared vault warning' });
		banner.createEl('p', {
			text: 'Connecting to a room will sync your local vault with the server. Any local files not present on the server will be moved to your local system trash.',
		});

		// --- Connection & Server Settings ---
		new Setting(containerEl)
			.setName('Server URL')
			.setDesc('WebSocket endpoint of the collab server, e.g. ws://127.0.0.1:5612 or https://collab.example.com')
			.addText((text) =>
				text
					.setPlaceholder('Example: ws://127.0.0.1:5612')
					.setValue(draft.serverUrl)
					.onChange((value) => {
						draft.serverUrl = value.trim();
					}),
			);

		new Setting(containerEl)
			.setName('Server password')
			.setDesc('Password required by the host to connect to this server.')
			.addText((text) => {
				text.inputEl.type = 'password';
				text
					.setPlaceholder('Server password')
					.setValue(draft.serverPassword ?? DEFAULT_SETTINGS.serverPassword ?? '')
					.onChange((value) => {
						draft.serverPassword = value.trim();
					});
			})
			.addExtraButton((btn) => {
				btn
					.setIcon('eye')
					.setTooltip('Toggle password visibility')
					.onClick(() => {
						const input = btn.extraSettingsEl.parentElement?.querySelector('input');
						if (input) {
							input.type = input.type === 'password' ? 'text' : 'password';
						}
					});
			});

		// Rooms Section: only active room and collapsed other rooms
		this.roomsContainerEl = containerEl.createDiv({ cls: 'synqra-rooms-section' });
		this.renderRoomsList();

		new Setting(containerEl)
			.setName('Display name')
			.setDesc('The name shown to other collaborators.')
			.addText((text) =>
				text
					.setPlaceholder(getRandomUsername())
					.setValue(draft.displayName)
					.onChange((value) => {
						draft.displayName = value.trim() || getRandomUsername();
					}),
			)
			.addButton((button) =>
				button
					.setButtonText('Randomize')
					.setTooltip('Pick a random user name')
					.onClick(() => {
						draft.displayName = getRandomUsername();
						this.display();
					}),
			);

		const colorSetting = new Setting(containerEl)
			.setName('Cursor color')
			.setDesc('Pick a color for selection highlights and collaborator markers.');

		colorSetting.addText((text) =>
			text
				.setPlaceholder('#30Bced')
				.setValue(draft.cursorColor)
				.onChange((value) => {
					draft.cursorColor = value.trim();
				}),
		);

		colorSetting.addButton((button) =>
			button
				.setButtonText('Randomize')
				.setTooltip('Pick a random preset color')
				.onClick(() => {
					draft.cursorColor = getRandomPresetColor();
					this.display();
				}),
		);

		new Setting(containerEl)
			.setName('Shared folder')
			.setDesc('Folder path to sync and collaborate on (e.g. "collab"). Leave blank to sync the entire vault.')
			.addText((text) =>
				text
					.setPlaceholder('Entire vault')
					.setValue(draft.sharedFolder ?? '')
					.onChange((value) => {
						draft.sharedFolder = value.trim();
					}),
			);

		new Setting(containerEl)
			.setName('Auto-connect on startup')
			.setDesc('Connect to the room automatically when Obsidian opens.')
			.addToggle((toggle) =>
				toggle.setValue(draft.autoConnect).onChange((value) => {
					draft.autoConnect = value;
				}),
			);

		// Single Confirm & Connect CTA at bottom of Connection section
		new Setting(containerEl)
			.setName('Confirm settings & connect')
			.setDesc('Save settings and connect now with current configuration.')
			.addButton((btn) =>
				btn
					.setButtonText('Confirm & connect')
					.setCta()
					.onClick(async () => {
						await this.applyAndConnect();
					}),
			);

		// --- Admin Panel Section ---
		containerEl.createEl('hr', { cls: 'collab-divider' });
		new Setting(containerEl).setName('Server admin controls').setHeading();
		containerEl.createEl('p', {
			text: 'Enter the server admin password to create, manage, and delete collaboration rooms on this server.',
			cls: 'setting-item-description',
		});

		const adminSetting = new Setting(containerEl)
			.setName('Admin password')
			.setDesc('Used exclusively for managing rooms on the host server.');

		adminSetting.addText((text) => {
			text.inputEl.type = 'password';
			text
				.setPlaceholder('Admin password')
				.setValue(draft.adminPassword ?? '')
				.onChange((value) => {
					draft.adminPassword = value;
				});
		});

		adminSetting.addButton((btn) => {
			btn
				.setButtonText(this.isAdminUnlocked ? 'Refresh rooms' : 'Unlock admin panel')
				.setCta()
				.onClick(async () => {
					await this.verifyAndLoadAdminRooms();
				});
		});

		if (this.isAdminUnlocked) {
			const adminBox = containerEl.createDiv({ cls: 'collab-admin-panel' });
			new Setting(adminBox).setName('Create new room').setHeading();

			new Setting(adminBox)
				.setName('New room ID')
				.setDesc('Unique room identifier (letters, numbers, dashes, underscores).')
				.addText((text) =>
					text
						.setPlaceholder('Example: team-vault')
						.setValue(this.newRoomId)
						.onChange((val) => {
							this.newRoomId = val;
						}),
				)
				.addText((text) =>
					text
						.setPlaceholder('Optional description')
						.setValue(this.newRoomDesc)
						.onChange((val) => {
							this.newRoomDesc = val;
						}),
				)
				.addButton((btn) =>
					btn
						.setButtonText('Create room')
						.setCta()
						.onClick(async () => {
							if (!this.newRoomId.trim()) {
								new Notice('Please enter a room ID');
								return;
							}
							await this.createRoomOnServer(this.newRoomId.trim(), this.newRoomDesc.trim());
						}),
				);

			new Setting(adminBox).setName('Registered rooms on server').setHeading();

			if (this.isLoadingRooms) {
				adminBox.createEl('p', { text: 'Loading rooms from server...', cls: 'setting-item-description' });
			} else if (this.adminRooms.length === 0) {
				adminBox.createEl('p', { text: 'No rooms found on this server.', cls: 'setting-item-description' });
			} else {
				for (const room of this.adminRooms) {
					const isConnected = this.plugin.isConnected();
					const isCurrentConnected = isConnected && this.plugin.settings.roomId === room.id;
					const isDraftSelected = draft.roomId === room.id;
					const roomTag = isCurrentConnected ? '(Connected)' : isDraftSelected ? '(Selected)' : '';
					const itemSetting = new Setting(adminBox)
						.setName(`${room.id} ${roomTag}`.trim())
						.setDesc(
							`Peers online: ${room.activePeers} | Documents: ${room.docCount}${room.description ? ` | ${room.description}` : ''}`,
						);

					if (!isDraftSelected && !isCurrentConnected) {
						itemSetting.addButton((btn) =>
							btn.setButtonText('Select room').onClick(() => {
								draft.roomId = room.id;
								new Notice(`Selected room '${room.id}'. Click 'Confirm & connect' to apply.`);
								this.renderRoomsList();
								this.display();
							}),
						);
					}

					itemSetting.addButton((btn) =>
						btn
							.setButtonText('Delete room')
							.setWarning()
							.onClick(() => {
								new ConfirmDeleteModal(this.app, room.id, async () => {
									await this.deleteRoomOnServer(room.id);
								}).open();
							}),
					);
				}
			}
		}
	}

	private renderRoomsList(): void {
		if (!this.roomsContainerEl) return;
		this.roomsContainerEl.empty();
		const draft = this.draftSettings || this.plugin.settings;
		const isConnected = this.plugin.isConnected();
		const connectedRoomId = this.plugin.settings.roomId;

		// Only show active room field information if a room is actively connected to by the user
		if (isConnected && connectedRoomId) {
			const activeRoomInfo = this.serverRooms.find((r) => r.id === connectedRoomId);
			const activeDesc = activeRoomInfo
				? `Peers online: ${activeRoomInfo.activePeers} | Documents: ${activeRoomInfo.docCount}${activeRoomInfo.description ? ` | ${activeRoomInfo.description}` : ''}`
				: 'Connected collaboration room';

			const activeItem = new Setting(this.roomsContainerEl)
				.setName(connectedRoomId)
				.setDesc(activeDesc);

			activeItem.addButton((btn) =>
				btn
					.setButtonText('Connected')
					.setDisabled(true),
			);
		}

		// Rooms list (either other rooms if connected, or all server rooms if not connected)
		const candidateRooms = isConnected && connectedRoomId
			? this.serverRooms.filter((r) => r.id !== connectedRoomId)
			: this.serverRooms;

		if (candidateRooms.length > 0) {
			const detailsEl = this.roomsContainerEl.createEl('details', { cls: 'synqra-rooms-details' });
			if (this.isRoomsExpanded) {
				detailsEl.setAttribute('open', '');
			}
			detailsEl.addEventListener('toggle', () => {
				this.isRoomsExpanded = detailsEl.open;
			});

			const summaryTitle = isConnected
				? `Other rooms on server (${candidateRooms.length})`
				: `Available rooms on server (${candidateRooms.length})`;

			detailsEl.createEl('summary', {
				text: summaryTitle,
				cls: 'synqra-rooms-summary',
			});

			for (const room of candidateRooms) {
				const isSelectedDraft = draft.roomId === room.id;
				const item = new Setting(detailsEl)
					.setName(room.id)
					.setDesc(
						`Peers online: ${room.activePeers} | Documents: ${room.docCount}${room.description ? ` | ${room.description}` : ''}`,
					);

				if (isSelectedDraft) {
					item.addButton((btn) =>
						btn
							.setButtonText('Selected')
							.setDisabled(true),
					);
				} else {
					item.addButton((btn) =>
						btn
							.setButtonText('Select room')
							.onClick(() => {
								draft.roomId = room.id;
								this.renderRoomsList();
							}),
					);
				}
			}
		}
	}

	private async applyAndConnect(): Promise<void> {
		if (!this.draftSettings) return;
		if (!this.draftSettings.roomId.trim()) {
			new Notice('Please select or create a room before connecting');
			return;
		}
		if (!this.draftSettings.displayName.trim()) {
			this.draftSettings.displayName = getRandomUsername();
		}
		this.plugin.settings = Object.assign({}, this.draftSettings);
		await this.plugin.saveSettings();
		this.plugin.presenceManager.debouncedBroadcastPresence();
		this.plugin.onActiveFileChange();
		this.plugin.scheduleReconnect();
		new Notice(`Saved settings and connecting to '${this.plugin.settings.roomId}'...`);
		this.renderRoomsList();
	}

	private async fetchServerRooms(silent = true): Promise<void> {
		const serverUrl = this.draftSettings?.serverUrl?.trim() || this.plugin.settings.serverUrl?.trim();
		if (!serverUrl) return;

		const httpUrl = toHttpUrl(serverUrl);
		const sep = httpUrl.endsWith('/') ? '' : '/';
		const serverPass = this.draftSettings?.serverPassword?.trim() ?? this.plugin.settings.serverPassword?.trim() ?? '';

		try {
			this.isLoadingServerRooms = true;
			const res = await requestUrl({
				url: `${httpUrl}${sep}api/rooms`,
				method: 'GET',
				headers: {
					Authorization: `Bearer ${serverPass}`,
					'x-server-password': serverPass,
				},
				throw: false,
			});

			if (res.status === 200) {
				const data = res.json as { rooms: RoomInfo[] };
				this.serverRooms = data.rooms || [];
				if (this.draftSettings) {
					const hasDraftRoom = this.serverRooms.some((r) => r.id === this.draftSettings?.roomId);
					if (!hasDraftRoom && !this.plugin.isConnected()) {
						this.draftSettings.roomId = '';
					}
				}
				if (!this.serverRooms.some((r) => r.id === this.plugin.settings.roomId) && !this.plugin.isConnected()) {
					this.plugin.settings.roomId = '';
				}
				this.renderRoomsList();
			} else if (res.status === 401) {
				if (!silent) {
					new Notice('Server authentication failed: check server password');
				}
			} else if (res.status === 404) {
				if (!silent) {
					new Notice('Server returned 404: /api/rooms not found. Please update and restart your synqra server container to enable room discovery.');
				}
			}
		} catch (err) {
			if (!silent) {
				new Notice(`Failed to fetch rooms: ${err instanceof Error ? err.message : String(err)}`);
			}
		} finally {
			this.isLoadingServerRooms = false;
		}
	}

	private async verifyAndLoadAdminRooms(): Promise<void> {
		const adminPass = this.draftSettings?.adminPassword?.trim() ?? this.plugin.settings.adminPassword?.trim() ?? '';
		if (!adminPass) {
			new Notice('Please enter the admin password first');
			return;
		}

		const serverUrl = this.draftSettings?.serverUrl?.trim() || this.plugin.settings.serverUrl?.trim();
		const httpUrl = toHttpUrl(serverUrl);
		const sep = httpUrl.endsWith('/') ? '' : '/';

		try {
			this.isLoadingRooms = true;
			const verifyRes = await requestUrl({
				url: `${httpUrl}${sep}api/admin/verify`,
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${adminPass}`,
				},
				body: JSON.stringify({ adminPassword: adminPass }),
				throw: false,
			});

			if (verifyRes.status !== 200) {
				this.isAdminUnlocked = false;
				new Notice('Admin verification failed: invalid admin password');
				this.display();
				return;
			}

			this.isAdminUnlocked = true;
			await this.fetchRoomsList();
			new Notice('Admin controls unlocked successfully');
		} catch (err) {
			new Notice(`Failed to connect to server admin API: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			this.isLoadingRooms = false;
			this.display();
		}
	}

	private async fetchRoomsList(): Promise<void> {
		const adminPass = this.draftSettings?.adminPassword?.trim() ?? this.plugin.settings.adminPassword?.trim() ?? '';
		const serverUrl = this.draftSettings?.serverUrl?.trim() || this.plugin.settings.serverUrl?.trim();
		const httpUrl = toHttpUrl(serverUrl);
		const sep = httpUrl.endsWith('/') ? '' : '/';

		try {
			const res = await requestUrl({
				url: `${httpUrl}${sep}api/admin/rooms`,
				method: 'GET',
				headers: {
					Authorization: `Bearer ${adminPass}`,
				},
				throw: false,
			});

			if (res.status === 200) {
				const data = res.json as { rooms: RoomInfo[] };
				this.adminRooms = data.rooms || [];
			} else {
				new Notice('Failed to load room list from server');
			}
		} catch {
			new Notice('Failed to load room list from server');
		}
	}

	private async createRoomOnServer(roomId: string, description: string): Promise<void> {
		const adminPass = this.draftSettings?.adminPassword?.trim() ?? this.plugin.settings.adminPassword?.trim() ?? '';
		const serverUrl = this.draftSettings?.serverUrl?.trim() || this.plugin.settings.serverUrl?.trim();
		const httpUrl = toHttpUrl(serverUrl);
		const sep = httpUrl.endsWith('/') ? '' : '/';

		try {
			const res = await requestUrl({
				url: `${httpUrl}${sep}api/admin/rooms`,
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${adminPass}`,
				},
				body: JSON.stringify({ roomId, description }),
				throw: false,
			});

			if (res.status === 200 || res.status === 201) {
				new Notice(`Room '${roomId}' created successfully!`);
				this.newRoomId = '';
				this.newRoomDesc = '';
				await this.fetchRoomsList();
				await this.fetchServerRooms(true);
				this.display();
			} else {
				const json = res.json as { error?: string };
				new Notice(`Error creating room: ${json?.error ?? 'Unknown error'}`);
			}
		} catch (err) {
			new Notice(`Error creating room: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async deleteRoomOnServer(roomId: string): Promise<void> {
		const adminPass = this.draftSettings?.adminPassword?.trim() ?? this.plugin.settings.adminPassword?.trim() ?? '';
		const serverUrl = this.draftSettings?.serverUrl?.trim() || this.plugin.settings.serverUrl?.trim();
		const httpUrl = toHttpUrl(serverUrl);
		const sep = httpUrl.endsWith('/') ? '' : '/';

		try {
			const res = await requestUrl({
				url: `${httpUrl}${sep}api/admin/rooms/${encodeURIComponent(roomId)}`,
				method: 'DELETE',
				headers: {
					Authorization: `Bearer ${adminPass}`,
				},
				throw: false,
			});

			if (res.status === 200) {
				new Notice(`Room '${roomId}' deleted from server`);
				if (this.draftSettings && this.draftSettings.roomId === roomId) {
					this.draftSettings.roomId = '';
				}
				if (this.plugin.settings.roomId === roomId) {
					this.plugin.settings.roomId = '';
					await this.plugin.saveSettings();
					this.plugin.disconnect();
				}
				await this.fetchRoomsList();
				await this.fetchServerRooms(true);
				this.display();
			} else {
				const json = res.json as { error?: string };
				new Notice(`Error deleting room: ${json?.error ?? 'Unknown error'}`);
			}
		} catch (err) {
			new Notice(`Error deleting room: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}