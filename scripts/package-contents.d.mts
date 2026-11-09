/**
 * Types for package-contents.mjs, plain JavaScript for the same reason as
 * verify-package.mjs: CI runs the check with a bare `node` and no build step.
 */

/** A platform a package is made for. */
export type PackagePlatform = 'linux' | 'win32';

/** What the app uses of one external module. */
export interface ModuleRuntimeFiles {
  /** Files it cannot run without, per platform; relative to the module. */
  required: Record<PackagePlatform, string[]>;
  /** Whether a file (relative to the module, forward slashes) may ship on a platform. */
  keeps: (file: string, platform: string) => boolean;
}

export const RUNTIME_FILES: Record<string, ModuleRuntimeFiles>;

/** Native files whose format must be the target's, relative to node_modules. */
export const NATIVE_FILES: Record<PackagePlatform, string[]>;

/** The executable format each platform runs. */
export const EXECUTABLE_FORMAT: Record<PackagePlatform, 'elf' | 'pe'>;

/** The modules in `modules` that RUNTIME_FILES says nothing about. */
export function modulesWithoutRuntimeFiles(modules: string[]): string[];

/** Files under a node_modules directory the app does not use on a platform. */
export function unexpectedFiles(nodeModulesDir: string, platform: string): string[];

/** Files the app needs on a platform, absent from a node_modules directory. */
export function missingFiles(nodeModulesDir: string, platform: string): string[];

/** Remove what the app does not use; returns the bytes removed. Throws if a needed file is missing after. */
export function trimToRuntime(nodeModulesDir: string, platform: string): number;

/** The executable format a file starts with. */
export function executableFormatOf(file: string): 'elf' | 'pe' | null;

/** Native files not in the platform's executable format, described. */
export function foreignExecutables(nodeModulesDir: string, platform: string): string[];
