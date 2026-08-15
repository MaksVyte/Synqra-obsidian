import { App, Modal, Notice, PluginSettingTab, requestUrl, Setting } from 'obsidian';
import type CollabPlugin from './main';
import {
	DEFAULT_SETTINGS,
	getRandomPresetColor,
	getRandomUsername,
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
		new Setting(contentEl).setName(`Delete Room '${this.roomId}'?`).setHeading();
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
					.setButtonText('Delete Permanently')
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
	private isAdminUnlocked = false;
	private adminRooms: RoomInfo[] = [];
	private isLoadingRooms = false;
	private newRoomId = '';
	private newRoomDesc = '';

	constructor(app: App, plugin: CollabPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions() {
		return [
			{
				name: 'Server URL',
				description: 'WebSocket endpoint of the collab server',
			},
			{
				name: 'Server Password',
				description: 'Password required by the host to connect to this server',
			},
			{
				name: 'Display name',
				description: 'The name shown to other collaborators',
			},
			{
				name: 'Cursor color',
				description: 'Color of your cursor and selection as seen by other peers',
			},
			{
				name: 'Room ID',
				description: 'The collaboration room ID to share a vault',
			},
			{
				name: 'Auto-connect on startup',
				description: 'Connect to the room automatically when Obsidian opens',
			},
			{
				name: 'Admin Password',
				description: 'Used exclusively for managing rooms on the host server',
			},
		];
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName('Connection').setHeading();

		// Warning banner
		const banner = containerEl.createDiv({ cls: 'synqra-warning' });
		banner.createDiv({ cls: 'synqra-warning-title', text: '⚠️ Shared Vault Warning' });
		banner.createEl('p', {
			text: 'Connecting to a room will sync your local vault with the server. Any local files not present on the server will be moved to your local system trash.',
		});

		// --- Connection & Server Settings ---
		new Setting(containerEl)
			.setName('Server URL')
			.setDesc('WebSocket endpoint of the collab server, e.g. ws://127.0.0.1:5612 or https://collab.example.com')
			.addText((text) =>
				text
					.setPlaceholder('ws://127.0.0.1:5612')
					.setValue(this.plugin.settings.serverUrl)
					.onChange(async (value) => {
						this.plugin.settings.serverUrl = value.trim();
						await this.plugin.saveSettings();
						this.plugin.scheduleReconnect();
					}),
			);

		new Setting(containerEl)
			.setName('Server Password')
			.setDesc('Password required by the host to connect to this server.')
			.addText((text) => {
				text.inputEl.type = 'password';
				text
					.setPlaceholder('Server password')
					.setValue(this.plugin.settings.serverPassword ?? DEFAULT_SETTINGS.serverPassword ?? '')
					.onChange(async (value) => {
						this.plugin.settings.serverPassword = value;
						await this.plugin.saveSettings();
						this.plugin.scheduleReconnect();
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

		new Setting(containerEl)
			.setName('Display name')
			.setDesc('The name shown to other collaborators.')
			.addText((text) =>
				text
					.setPlaceholder(getRandomUsername())
					.setValue(this.plugin.settings.displayName)
					.onChange(async (value) => {
						this.plugin.settings.displayName = value.trim() || getRandomUsername();
						await this.plugin.saveSettings();
						this.plugin.scheduleReconnect();
					}),
			);

		const colorSetting = new Setting(containerEl)
			.setName('Cursor color')
			.setDesc('Color of your cursor and selection as seen by other peers.');

		colorSetting.addText((text) =>
			text
				.setPlaceholder('#30bced')
				.setValue(this.plugin.settings.cursorColor)
				.onChange(async (value) => {
					this.plugin.settings.cursorColor = value.trim();
					await this.plugin.saveSettings();
					this.plugin.scheduleReconnect();
				}),
		);

		colorSetting.addButton((button) =>
			button
				.setButtonText('Randomize')
				.setTooltip('Pick a random preset color')
				.onClick(async () => {
					this.plugin.settings.cursorColor = getRandomPresetColor();
					await this.plugin.saveSettings();
					this.plugin.scheduleReconnect();
					this.display();
				}),
		);

		new Setting(containerEl)
			.setName('Room ID')
			.setDesc('The collaboration room. Peers must use the same room ID to share a vault.')
			.addText((text) =>
				text
					.setPlaceholder('vault-a')
					.setValue(this.plugin.settings.roomId)
					.onChange(async (value) => {
						this.plugin.settings.roomId = value.trim() || DEFAULT_SETTINGS.roomId;
						await this.plugin.saveSettings();
						this.plugin.scheduleReconnect();
					}),
			);

		new Setting(containerEl)
			.setName('Auto-connect on startup')
			.setDesc('Connect to the room automatically when Obsidian opens.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoConnect).onChange(async (value) => {
					this.plugin.settings.autoConnect = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Reconnect now')
			.setDesc('Close the current connection and reconnect with the latest settings.')
			.addButton((button) =>
				button.setButtonText('Reconnect').onClick(() => {
					this.plugin.scheduleReconnect();
				}),
			);

		new Setting(containerEl)
			.setName('Sync vault manifest')
			.setDesc('Force a full scan and publish of the vault manifest to peers.')
			.addButton((button) =>
				button.setButtonText('Publish manifest').onClick(() => {
					void this.plugin.publishManifest();
				}),
			);

		// --- Admin Panel Section ---
		containerEl.createEl('hr', { cls: 'collab-divider' });
		new Setting(containerEl).setName('Server Admin Controls').setHeading();
		containerEl.createEl('p', {
			text: 'Enter the server Admin Password to create, manage, and delete collaboration rooms on this server.',
			cls: 'setting-item-description',
		});

		const adminSetting = new Setting(containerEl)
			.setName('Admin Password')
			.setDesc('Used exclusively for managing rooms on the host server.');

		adminSetting.addText((text) => {
			text.inputEl.type = 'password';
			text
				.setPlaceholder('Admin password')
				.setValue(this.plugin.settings.adminPassword ?? '')
				.onChange(async (value) => {
					this.plugin.settings.adminPassword = value;
					await this.plugin.saveSettings();
				});
		});

		adminSetting.addButton((btn) => {
			btn
				.setButtonText(this.isAdminUnlocked ? 'Refresh Rooms' : 'Unlock Admin Panel')
				.setCta()
				.onClick(async () => {
					await this.verifyAndLoadAdminRooms();
				});
		});

		if (this.isAdminUnlocked) {
			const adminBox = containerEl.createDiv({ cls: 'collab-admin-panel' });
			new Setting(adminBox).setName('Create New Room').setHeading();

			new Setting(adminBox)
				.setName('New Room ID')
				.setDesc('Unique room identifier (letters, numbers, dashes, underscores).')
				.addText((text) =>
					text
						.setPlaceholder('e.g. team-vault')
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
						.setButtonText('Create Room')
						.setCta()
						.onClick(async () => {
							if (!this.newRoomId.trim()) {
								new Notice('Please enter a Room ID');
								return;
							}
							await this.createRoomOnServer(this.newRoomId.trim(), this.newRoomDesc.trim());
						}),
				);

			new Setting(adminBox).setName('Registered Rooms on Server').setHeading();

			if (this.isLoadingRooms) {
				adminBox.createEl('p', { text: 'Loading rooms from server...', cls: 'setting-item-description' });
			} else if (this.adminRooms.length === 0) {
				adminBox.createEl('p', { text: 'No rooms found on this server.', cls: 'setting-item-description' });
			} else {
				for (const room of this.adminRooms) {
					const isCurrentRoom = this.plugin.settings.roomId === room.id;
					const roomSetting = new Setting(adminBox)
						.setName(`${room.id} ${isCurrentRoom ? '(Active Room)' : ''}`)
						.setDesc(
							`Peers Online: ${room.activePeers} | Documents: ${room.docCount}${room.description ? ` | ${room.description}` : ''}`,
						);

					if (!isCurrentRoom) {
						roomSetting.addButton((btn) =>
							btn.setButtonText('Join Room').onClick(async () => {
								this.plugin.settings.roomId = room.id;
								await this.plugin.saveSettings();
								this.plugin.scheduleReconnect();
								new Notice(`Switched active room to '${room.id}'`);
								this.display();
							}),
						);
					}

					roomSetting.addButton((btn) =>
						btn
							.setButtonText('Delete Room')
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

	private async verifyAndLoadAdminRooms(): Promise<void> {
		const adminPass = this.plugin.settings.adminPassword?.trim();
		if (!adminPass) {
			new Notice('Please enter the Admin Password first');
			return;
		}

		const httpUrl = toHttpUrl(this.plugin.settings.serverUrl);
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
				new Notice('Admin verification failed: Invalid admin password');
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
		const adminPass = this.plugin.settings.adminPassword?.trim() ?? '';
		const httpUrl = toHttpUrl(this.plugin.settings.serverUrl);
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
		const adminPass = this.plugin.settings.adminPassword?.trim() ?? '';
		const httpUrl = toHttpUrl(this.plugin.settings.serverUrl);
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

			if (res.status === 200) {
				new Notice(`Room '${roomId}' created successfully!`);
				this.newRoomId = '';
				this.newRoomDesc = '';
				await this.fetchRoomsList();
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
		const adminPass = this.plugin.settings.adminPassword?.trim() ?? '';
		const httpUrl = toHttpUrl(this.plugin.settings.serverUrl);
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
				new Notice(`Room '${roomId}' deleted from server.`);
				if (this.plugin.settings.roomId === roomId) {
					this.plugin.settings.roomId = 'vault-a';
					await this.plugin.saveSettings();
					this.plugin.scheduleReconnect();
				}
				await this.fetchRoomsList();
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