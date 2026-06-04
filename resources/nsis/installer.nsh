; Custom NSIS macros for the Philibert installer.
;
; This file plugs into the macro hooks exposed by electron-builder's
; assistedInstaller.nsh (customWelcomePage, customFinishPage, customInstall).
;
; What it does:
;   1. Adds a Welcome page that explains the two extraction phases up-front,
;      so the second progress-bar reset (Git Bash unpacking) does not feel
;      unexplained.
;   2. Customizes the Finish page so the desktop shortcut becomes an opt-in
;      checkbox (defaulted on) rather than being silently force-created.
;   3. Re-enables DetailPrint output and logs the Git Bash extraction phase
;      so users who open "Show details" see meaningful status messages.
;
; The desktop shortcut is created manually here because electron-builder.json
; sets `createDesktopShortcut: false`, which defines DO_NOT_CREATE_DESKTOP_SHORTCUT
; and turns the built-in addDesktopLink macro into a no-op.

!include "LogicLib.nsh"

; ---------------------------------------------------------------------------
; Welcome page
; ---------------------------------------------------------------------------
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Welcome to the ${PRODUCT_NAME} Setup Wizard"
  !define MUI_WELCOMEPAGE_TEXT "This wizard will install ${PRODUCT_NAME} ${VERSION} on your computer.$\r$\n$\r$\n${PRODUCT_NAME} bundles a portable Git Bash environment alongside the application, so the installer runs two extraction phases: first the app files, then the Git Bash bundle. The second phase can take a minute the first time.$\r$\n$\r$\nIt is recommended that you close other applications before continuing. Click Next to continue."
  !insertmacro MUI_PAGE_WELCOME
!macroend

; ---------------------------------------------------------------------------
; Finish page (with opt-in desktop shortcut)
; ---------------------------------------------------------------------------

; electron-builder's assistedInstaller.nsh only declares `Function StartApp`
; inside the default finish-page branch. Because we define customFinishPage,
; that branch is skipped, so we must declare the function ourselves.
;
; We define our installer-side Functions through the customHeader hook because
; electron-builder includes this file via sharedHeader, which is processed
; BEFORE installer.nsi loads common.nsh. Any reference to common.nsh-defined
; symbols (StartApp macro, APP_EXECUTABLE_FILENAME, APP_DESCRIPTION, APP_ID,
; ...) at script-top therefore fails with "macro not found" or "unknown
; variable/constant" warnings (treated as errors).
;
; customHeader is inserted by installer.nsi after both common.nsh and the
; $launchLink Var declaration, so all symbols are available. Skipped during
; the uninstaller pass (BUILD_UNINSTALLER) where these symbols/vars are not
; declared and these installer-only functions are unused.
;
; StartApp body is inlined (using $1 as scratch) rather than calling
; `!insertmacro StartApp` because that macro declares `Var /GLOBAL startAppArgs`,
; and installSection.nsh:108 already inserts it via doStartApp — a second
; expansion would fail with "variable already declared". This mirrors what
; assistedInstaller.nsh:51-58 does for its own default StartApp function.
!macro customHeader
  !ifndef BUILD_UNINSTALLER
    Function StartApp
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd

    Function finishPageCreateDesktopShortcut
      ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
        CreateShortCut "$newDesktopLink" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 "" "" "${APP_DESCRIPTION}"
        ClearErrors
        WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
        System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
      ${EndIf}
    FunctionEnd
  !endif
!macroend

!macro customFinishPage
  ; "Run Philibert" checkbox — same StartApp function the default finish page
  ; uses. Honor HIDE_RUN_AFTER_FINISH (set when `runAfterFinish: false` in
  ; electron-builder config) so this stays consistent with the default behavior.
  !ifndef HIDE_RUN_AFTER_FINISH
    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !endif

  ; Repurpose the SHOWREADME slot as a "Create a desktop shortcut" checkbox.
  ; Defining MUI_FINISHPAGE_SHOWREADME (even as empty) makes MUI render the
  ; checkbox; supplying _FUNCTION makes it call our handler instead of
  ; ShellExec'ing a readme file. The checkbox defaults to checked because we
  ; do not define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED.
  !define MUI_FINISHPAGE_SHOWREADME ""
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "Create a desktop shortcut for ${PRODUCT_NAME}"
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION "finishPageCreateDesktopShortcut"

  !insertmacro MUI_PAGE_FINISH
!macroend

; ---------------------------------------------------------------------------
; Custom uninstall step (clean up the opt-in desktop shortcut)
; ---------------------------------------------------------------------------
;
; Setting `createDesktopShortcut: false` in electron-builder.json defines
; DO_NOT_CREATE_DESKTOP_SHORTCUT, which not only skips auto-creation at install
; time (uninstaller.nsh:193) but also skips removal at uninstall time. Since
; our finish-page checkbox may have created a shortcut, we must remove it
; ourselves so uninstall is clean. setLinkVars (uninstaller.nsh:154) runs
; before this hook, so $oldDesktopLink and $newDesktopLink are populated.
!macro customUnInstall
  ${If} ${FileExists} "$oldDesktopLink"
    WinShell::UninstShortcut "$oldDesktopLink"
    Delete "$oldDesktopLink"
  ${EndIf}
  ${If} "$newDesktopLink" != "$oldDesktopLink"
    ${If} ${FileExists} "$newDesktopLink"
      WinShell::UninstShortcut "$newDesktopLink"
      Delete "$newDesktopLink"
    ${EndIf}
  ${EndIf}
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend

; ---------------------------------------------------------------------------
; Custom install step (Git Bash extraction + detail logging)
; ---------------------------------------------------------------------------
!macro customInstall
  ; electron-builder's installSection.nsh sets `SetDetailsPrint none` for
  ; non-silent installs, which silences the details pane entirely. Re-enable
  ; it so the messages below are visible when the user opens "Show details".
  SetDetailsPrint both

  ${If} ${FileExists} "$INSTDIR\resources\git-bash.tar.bz2"
    DetailPrint "Extracting bundled Git Bash environment (this can take a minute)..."
    CreateDirectory "$INSTDIR\resources\git-bash"
    nsExec::ExecToLog 'tar -xjf "$INSTDIR\resources\git-bash.tar.bz2" -C "$INSTDIR\resources\git-bash" --exclude="dev" --exclude="etc/mtab"'
    Pop $0
    ${If} $0 == "0"
      DetailPrint "Git Bash bundle extracted successfully."
      ${If} ${FileExists} "$INSTDIR\resources\version.txt"
        CopyFiles /SILENT "$INSTDIR\resources\version.txt" "$INSTDIR\resources\git-bash\.version"
        DetailPrint "Recorded Git Bash bundle version."
      ${EndIf}
    ${Else}
      DetailPrint "Warning: Git Bash extraction returned exit code $0."
    ${EndIf}
  ${EndIf}

  DetailPrint "Finalizing installation..."
!macroend
