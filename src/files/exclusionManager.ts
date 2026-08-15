import type { Vault } from 'obsidian';
import { normalizePath } from '../utils';

export class ExclusionManager {
	constructor(private vault?: Vault) {}

	isExcluded(rawPath: string): boolean {
		const path = normalizePath(rawPath);
		if (!path) return true;
		const configDir = this.vault?.configDir ?? '.obsidian';
		if (path.startsWith(configDir) || path.startsWith('.git') || path.startsWith('.trash')) {
			return true;
		}
		return false;
	}
}
