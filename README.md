# Synqra (Obsidian Plugin)

> Real-time multi-user live collaboration, note syncing, and Excalidraw whiteboards for Obsidian.

---

## Features

- **Live Concurrent Note Editing**: Multi-cursor, real-time collaboration powered by conflict-free Yjs CRDTs.
- **Excalidraw Live Canvas**: Draw simultaneously with peers on `.excalidraw` and `.excalidraw.md` drawings at 30+ FPS.
- **Server Password Authentication**: Securely connect to self-hosted Synqra relay servers.
- **Admin Room Controls**: Server admins can create, view, and delete isolated collaboration rooms directly from the plugin settings.
- **Automatic Background Sync**: Keeps your shared notes synchronized with zero data loss or text collisions.

---

## Installation

### Method 1: Using BRAT (Recommended for Pre-Release)
1. Install the **BRAT** (Beta Reviewers Auto-update Tester) plugin from Obsidian Community Plugins.
2. In Obsidian **Settings** → **BRAT** → Click **Add Beta plugin**.
3. Enter the repository URL: `https://github.com/MaksVyte/Synqra-obsidian`.
4. Enable **Synqra** under Community Plugins.

### Method 2: Manual Installation
1. Go to the [Releases](https://github.com/MaksVyte/Synqra-obsidian/releases/latest) page and download:
   - `main.js`
   - `manifest.json`
   - `styles.css`
2. In your Obsidian vault folder, create the directory:
   `<YourVault>/.obsidian/plugins/synqra/`
3. Place `main.js`, `manifest.json`, and `styles.css` into that folder.
4. In Obsidian **Settings** → **Community Plugins**, click **Reload plugins** and toggle on **Synqra**.

---

## Configuration & Getting Started

1. Open Obsidian **Settings** → **Synqra - Live Collaboration**.
2. **Server URL**: Enter your self-hosted Synqra server address (e.g. `ws://<your-server-ip>:5612` or `wss://collab.yourdomain.com`).
   - *To host your own server, check out the [Synqra Server Repository](https://github.com/MaksVyte/Synqra).*
3. **Server Password**: Enter the server password provided by the server host.
4. **Room ID**: Enter the collaboration room identifier (e.g. `vault-a` or your team room).
5. **Display Name & Cursor Color**: Customize how other collaborators see your cursor and selections.

### Admin Room Controls (Server Admins)
1. Scroll down to **Server Admin Controls** in the plugin settings.
2. Enter your `ADMIN_PASSWORD` and click **Unlock Admin Panel**.
3. You can now:
   - **View Live Rooms**: Check real-time connected users and active documents.
   - **Create New Rooms**: Enter a Room ID to initialize a new room on the server.
   - **Switch Rooms**: Switch your active vault connection with 1-click.
   - **Delete Rooms**: Permanently remove unused rooms and clean up server storage.

---

## Network Use & Privacy

Synqra connects exclusively to the self-hosted or user-specified relay server entered in the **Server URL** setting (via WebSocket and HTTP). It transmits document updates, cursor presence coordinates, and binary file chunks to sync notes between active collaborators in the specified room.

- **No Third-Party Telemetry**: Synqra does not collect, track, or send analytics or telemetry to any external service.
- **Self-Contained**: All collaborative data remains strictly between your Obsidian client and your chosen relay server.

---

## License

MIT License. Copyright (c) 2026 MaksVyte. See [LICENSE](LICENSE) for details.
