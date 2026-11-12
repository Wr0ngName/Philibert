/**
 * The part of electron-installer-redhat (v4, which Electron Forge 8's RPM
 * maker uses) that forge.config.ts reaches into: the installer class whose
 * spec file it edits before rpmbuild runs. The package ships no types.
 */
declare module 'electron-installer-redhat' {
  export const Installer: {
    prototype: {
      /** Where the spec file is written. */
      readonly specPath: string;
      /** Writes the spec file; called by name while the package is put together. */
      createSpec(): Promise<void>;
    };
  };
}
