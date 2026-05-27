; Custom NSIS macros for Philibert installer
; Extracts bundled Git Bash during installation while elevated, so the app
; does not need write access to Program Files at runtime.

!include "LogicLib.nsh"

!macro customInstall
  ; Extract bundled Git Bash during installation (runs elevated).
  ; The app only reads from this directory at runtime.
  ${If} ${FileExists} "$INSTDIR\resources\git-bash.tar.bz2"
    CreateDirectory "$INSTDIR\resources\git-bash"
    nsExec::ExecToLog 'tar -xjf "$INSTDIR\resources\git-bash.tar.bz2" -C "$INSTDIR\resources\git-bash" --exclude="dev" --exclude="etc/mtab"'
    Pop $0
    ${If} $0 == "0"
      ; Copy version file if present
      ${If} ${FileExists} "$INSTDIR\resources\version.txt"
        CopyFiles /SILENT "$INSTDIR\resources\version.txt" "$INSTDIR\resources\git-bash\.version"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
