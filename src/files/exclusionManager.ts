import type { Vault } from 'obsidian';
import { normalizePath } from '../utils';

export class ExclusionManager {
	constructor(private readonly vault: Vault) {}

	isExcluded(rawPath: string): boolean {
		const path = normalizePath(rawPath);
		if (!path) return true;
		const configDir = this.vault.configDir;
		if ((configDir && path.startsWith(configDir)) || path.startsWith('.git') || path.startsWith('.trash')) {
			return true;
		}
		return false;
	}
}
