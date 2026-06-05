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
;   4. Drives the install page header ("Step X of 3 — ...") so
;      non-technical users always see what the installer is doing, even
;      while Nsis7z::Extract and CopyFiles repaint the status bar above
;      the progress bar. Step 1 is set at COMPILE time via
;      MUI_PAGE_HEADER_TEXT/_SUBTEXT (overriding MUI's "Installing /
;      Please wait..." defaults before MUI_PAGE_INSTFILES is processed),
;      because MUI_HEADER_TEXT from a custom PAGE_SHOW callback is run
;      BEFORE MUI sets the page defaults and gets clobbered. Steps 2 and
;      3 use MUI_HEADER_TEXT from inside the install Section (which runs
;      AFTER MUI's PAGE_SHOW, so our values win).
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

  ; Override the install (instfiles) page header at COMPILE TIME so the
  ; user sees "Step 1 of 3 — ..." from the moment the page appears.
  ; MUI_PAGE_HEADER_TEXT / MUI_PAGE_HEADER_SUBTEXT apply to the next
  ; MUI_PAGE_* declaration (MUI_PAGE_INSTFILES in assistedInstaller.nsh:46)
  ; and are !undef'd by MUI after use, so they do not bleed into the
  ; Finish page that follows.
  ;
  ; This compile-time override is necessary because MUI sets its default
  ; header text ("Installing" / "Please wait while ${MUI_PRODUCT} is being
  ; installed") inside the install page's internal SHOW handler, which
  ; runs AFTER any custom MUI_PAGE_CUSTOMFUNCTION_SHOW we wire up — so a
  ; runtime MUI_HEADER_TEXT call from instFilesPageShow gets clobbered
  ; immediately. Steps 2 and 3 do use the runtime MUI_HEADER_TEXT in
  ; customInstall because that runs inside the install Section, AFTER
  ; MUI's PAGE_SHOW, so our header value wins.
  !define MUI_PAGE_HEADER_TEXT "${STEP1_TITLE}"
  !define MUI_PAGE_HEADER_SUBTEXT "${STEP1_SUBTITLE}"

  ; SHOW callback is still useful for seeding the details listbox (via
  ; DetailPrint with `both` before installSection.nsh:6 sets
  ; SetDetailsPrint=none) and the status bar above the progress bar (the
  ; latter will get clobbered by file-extraction output during the
  ; section, but the page header above stays intact thanks to the
  ; compile-time defines above).
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

    ; Step 1 setup. Runs once when the install page is shown, BEFORE the
    ; install Section starts. The page header is already set via the
    ; compile-time MUI_PAGE_HEADER_TEXT/_SUBTEXT defines in
    ; customWelcomePage; here we only seed the details listbox (so the
    ; "Show details" panel is not blank) and the status bar above the
    ; progress bar (which will get repainted by file-extraction output
    ; once the section starts running, but at least shows something
    ; until then).
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
