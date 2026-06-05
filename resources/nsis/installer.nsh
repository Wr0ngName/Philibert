; Custom NSIS macros for the Philibert installer.
;
; This file plugs into the macro hooks exposed by electron-builder's
; assistedInstaller.nsh (customWelcomePage, customPageAfterChangeDir,
; customFinishPage, customInstall).
;
; What it does:
;   1. Adds a Welcome page so users see what they're about to install.
;   2. Customizes the Finish page so the desktop shortcut becomes an opt-in
;      checkbox (defaulted OFF) rather than being silently force-created.
;   3. Restores the standard "Show details" button on the install/uninstall
;      pages (electron-builder hides it by default).
;   4. Drives the install page header ("Step X of 3 — ...") so
;      non-technical users always see what the installer is doing, even
;      while Nsis7z::Extract and CopyFiles repaint the status bar above
;      the progress bar.
;
;      Step 1 is set at COMPILE time via MUI_PAGE_HEADER_TEXT/_SUBTEXT,
;      defined in customPageAfterChangeDir — NOT customWelcomePage. These
;      defines are scoped to the next MUI_PAGE_* macro NSIS encounters
;      (see Pages.nsh:60-75 in the MUI2 source: MUI_HEADER_TEXT_PAGE
;      consumes them and !unsets them). assistedInstaller.nsh processes
;      MUI_PAGE_DIRECTORY at line 26 before MUI_PAGE_INSTFILES at line 46,
;      so defines set in customWelcomePage would be eaten by Directory.
;      customPageAfterChangeDir (line 43) is the only hook between them.
;
;      The same scoping rule applies to MUI_PAGE_CUSTOMFUNCTION_SHOW —
;      it must be set in customPageAfterChangeDir or it ends up bound to
;      the Directory page's SHOW handler instead of InstFiles's.
;
;      Steps 2 and 3 use runtime MUI_HEADER_TEXT from inside the install
;      Section (customInstall hook); the install page is already showing
;      by then, so SendMessage to $mui.Header.Text takes effect immediately.
;
; The desktop shortcut is created manually here because electron-builder.json
; sets `createDesktopShortcut: false`, which defines DO_NOT_CREATE_DESKTOP_SHORTCUT
; and turns the built-in addDesktopLink macro into a no-op.

!include "LogicLib.nsh"

; ---------------------------------------------------------------------------
; Step labels — kept in one place so the title and subtitle are consistent
; across the header, the status bar, and the details listbox.
; ---------------------------------------------------------------------------
!define STEP1_TITLE      "Step 1 of 3 — Installing application files"
!define STEP1_SUBTITLE   "Copying ${PRODUCT_NAME} program files. The progress bar may reset a couple of times during this step — that's normal."
!define STEP2_TITLE      "Step 2 of 3 — Setting up bundled Git tools"
!define STEP2_SUBTITLE   "Extracting the portable Git Bash environment. This is the longest step (up to a couple of minutes on slower disks)."
!define STEP3_TITLE      "Step 3 of 3 — Finalizing installation"
!define STEP3_SUBTITLE   "Almost done. Tidying up and registering ${PRODUCT_NAME}..."

; ---------------------------------------------------------------------------
; Welcome page
; ---------------------------------------------------------------------------
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Welcome to the ${PRODUCT_NAME} Setup Wizard"
  !define MUI_WELCOMEPAGE_TEXT "This wizard will install ${PRODUCT_NAME} ${VERSION} on your computer.$\r$\n$\r$\nIt is recommended that you close other applications before continuing. Click Next to continue."
  !insertmacro MUI_PAGE_WELCOME

  ; NOTE: Do NOT set MUI_PAGE_HEADER_TEXT/_SUBTEXT or MUI_PAGE_CUSTOMFUNCTION_SHOW
  ; here — they would be consumed by MUI_PAGE_DIRECTORY (assistedInstaller.nsh:26),
  ; not by MUI_PAGE_INSTFILES. They are set in customPageAfterChangeDir below.
!macroend

; ---------------------------------------------------------------------------
; Hook right before MUI_PAGE_INSTFILES — wire the install page header and
; SHOW callback here so they actually reach MUI_PAGE_INSTFILES.
; ---------------------------------------------------------------------------
; assistedInstaller.nsh:43 inserts this macro immediately before
; MUI_PAGE_INSTFILES at line 46. Nothing else sits between, so any MUI
; per-page defines we set here are consumed by MUI_PAGE_INSTFILES exactly
; once and then !unset by MUI.
!macro customPageAfterChangeDir
  ; Step 1 page header. MUI_PAGE_INSTFILES → MUI_FUNCTION_INSTFILESPAGE → PRE
  ; → MUI_HEADER_TEXT_PAGE picks these up (Pages.nsh:60-75 of MUI2 source).
  !define MUI_PAGE_HEADER_TEXT "${STEP1_TITLE}"
  !define MUI_PAGE_HEADER_SUBTEXT "${STEP1_SUBTITLE}"

  ; SHOW callback fires after MUI's PRE (which already set the Step 1
  ; header via the defines above) and after MUI's SHOW captured dialog
  ; handles. Used here only to seed the details listbox — the header
  ; itself is already set, so we don't re-set it at runtime.
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

    ; InstFiles page SHOW callback. Wired up via MUI_PAGE_CUSTOMFUNCTION_SHOW
    ; in customPageAfterChangeDir. By the time we run, MUI's PRE has already
    ; set the page header to "Step 1 of 3 — ..." (from the compile-time
    ; MUI_PAGE_HEADER_TEXT/_SUBTEXT defines), and MUI's SHOW has captured
    ; dialog handles. We seed the details listbox (with `both`) so the
    ; "Show details" panel isn't blank when expanded, plus a textonly print
    ; for the status bar above the progress bar (which file-extraction output
    ; will then repaint — that's fine, the persistent page header is the
    ; primary indicator).
    Function instFilesPageShow
      SetDetailsPrint both
      DetailPrint "${STEP1_TITLE}"
      DetailPrint "${STEP1_SUBTITLE}"

      SetDetailsPrint textonly
      DetailPrint "${STEP1_TITLE}..."
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
; Custom install step (Step 2: Git Bash extraction, then Step 3: finalize)
; ---------------------------------------------------------------------------
!macro customInstall
  ; --- Step 2 of 3: Git Bash extraction ---------------------------------
  ;
  ; Update the page header (top of page, persistent) and re-enable both
  ; status-bar and details-listbox output so users see what's happening
  ; during the longest single step of the install.
  !insertmacro MUI_HEADER_TEXT "${STEP2_TITLE}" "${STEP2_SUBTITLE}"

  SetDetailsPrint both
  DetailPrint ""
  DetailPrint "${STEP2_TITLE}"
  DetailPrint "${STEP2_SUBTITLE}"

  SetDetailsPrint textonly
  DetailPrint "${STEP2_TITLE}..."

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

  ; --- Step 3 of 3: Finalizing -----------------------------------------
  ;
  ; Brief — once customInstall returns, the install Section ends and MUI
  ; transitions to the Finish page. The header label still gives the user a
  ; clear "we're wrapping up" signal even if it's only on screen for a
  ; moment.
  !insertmacro MUI_HEADER_TEXT "${STEP3_TITLE}" "${STEP3_SUBTITLE}"

  SetDetailsPrint both
  DetailPrint ""
  DetailPrint "${STEP3_TITLE}"
  DetailPrint "${STEP3_SUBTITLE}"

  SetDetailsPrint textonly
  DetailPrint "${STEP3_TITLE}..."
!macroend
