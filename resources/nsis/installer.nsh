; Custom NSIS macros for the Philibert installer.
;
; This file plugs into the macro hooks exposed by electron-builder's
; assistedInstaller.nsh (customWelcomePage, customFinishPage, customInstall).
;
; What it does:
;   1. Adds a Welcome page so users see what they're about to install.
;   2. Customizes the Finish page so the desktop shortcut becomes an opt-in
;      checkbox (defaulted OFF) rather than being silently force-created.
;   3. Restores the standard "Show details" button on the install/uninstall
;      pages (electron-builder hides it by default).
;   4. Labels the status bar above the install progress bar with the current
;      phase ("Installing application files...", then "Extracting bundled
;      Git Bash environment...", then "Finalizing installation...") so the
;      user knows what each progress reset corresponds to without having to
;      open the details panel.
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
  !define MUI_WELCOMEPAGE_TEXT "This wizard will install ${PRODUCT_NAME} ${VERSION} on your computer.$\r$\n$\r$\nIt is recommended that you close other applications before continuing. Click Next to continue."
  !insertmacro MUI_PAGE_WELCOME

  ; Hook the next MUI page (the install/progress page) with a SHOW callback
  ; so we can label what is happening on the status bar. SHOW runs after the
  ; page is created but before installSection.nsh starts running file
  ; operations — perfect spot to set a status text that survives
  ; installSection.nsh's `SetDetailsPrint none`. The label persists through
  ; the multiple progress-bar resets inside installApplicationFiles (which
  ; runs File extraction, then Nsis7z::Extract, then CopyFiles, with no hook
  ; between them). customInstall later swaps the label for the Git Bash phase.
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW instFilesPageShow
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
  ; electron-builder's common.nsh:5 sets `ShowInstDetails nevershow`, which
  ; removes the "Show details" button entirely. Override to `hide` so the
  ; button is visible but the details pane stays collapsed by default —
  ; users can click to expand if they want to see what's happening.
  ; Same for the uninstaller (common.nsh:7 sets ShowUninstDetails nevershow
  ; when BUILD_UNINSTALLER is defined).
  ShowInstDetails hide
  ShowUninstDetails hide

  !ifndef BUILD_UNINSTALLER
    Function StartApp
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd

    ; Status-bar label for the install/progress page. Runs once when the page
    ; is shown, before the install Section starts. SetDetailsPrint=textonly
    ; routes our DetailPrint to the status bar (label above progress bar);
    ; installSection.nsh:6 then sets none, which suppresses further prints
    ; but does not clear the text we already wrote.
    Function instFilesPageShow
      SetDetailsPrint textonly
      DetailPrint "Installing application files..."
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
  ; ShellExec'ing a readme file. MUI_FINISHPAGE_SHOWREADME_NOTCHECKED makes
  ; the checkbox default to unchecked so users opt IN to a desktop shortcut.
  !define MUI_FINISHPAGE_SHOWREADME ""
  !define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
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
  ; Swap the status-bar label so the user sees we have moved past the
  ; application-files stage. textonly routes the next DetailPrint to the
  ; status bar above the progress bar.
  SetDetailsPrint textonly
  DetailPrint "Extracting bundled Git Bash environment..."

  ; Switch to both so the tar output (piped via nsExec::ExecToLog) shows in
  ; the "Show details" log too — useful if the user expands the panel.
  SetDetailsPrint both

  ${If} ${FileExists} "$INSTDIR\resources\git-bash.tar.bz2"
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

  SetDetailsPrint textonly
  DetailPrint "Finalizing installation..."
!macroend
