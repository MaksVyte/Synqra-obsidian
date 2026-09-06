import type { Vault } from 'obsidian';
import { normalizePath } from '../utils';

export class ExclusionManager {
	constructor(
		private readonly vault: Vault,
		private readonly getSharedFolder?: () => string,
	) {}

	isExcluded(rawPath: string): boolean {
		const path = normalizePath(rawPath);
		if (!path) return true;

		// Universal check: any path segment starting with '.' (e.g. .git, .trash, .obsidian, .DS_Store) or OS metadata files
		const segments = path.split('/');
		for (const segment of segments) {
			if (
				segment.startsWith('.') ||
				segment === 'Thumbs.db' ||
				segment === 'desktop.ini'
			) {
				return true;
			}
		}

		const configDir = this.vault.configDir ? normalizePath(this.vault.configDir) : null;
		if (configDir && (path === configDir || path.startsWith(configDir + '/'))) {
			return true;
		}

		const sharedFolder = this.getSharedFolder?.()?.trim();
		if (sharedFolder) {
			const normShared = normalizePath(sharedFolder).replace(/^\/+|\/+$/g, '');
			if (normShared && path !== normShared && !path.startsWith(normShared + '/')) {
				return true;
			}
		}
		return false;
	}
}
