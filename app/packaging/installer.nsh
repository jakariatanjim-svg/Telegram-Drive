!macro customInstall
  CreateDirectory "$INSTDIR\data"
  ; Grant normal Windows Users (*S-1-5-32-545, locale-independent SID) Modify rights
  ; on the chosen installation directory so portable data/ writes and silent in-app
  ; self-updates work without UAC elevation prompts.
  nsExec::ExecToLog 'icacls "$INSTDIR" /grant *S-1-5-32-545:(OI)(CI)M /T /C /Q'
!macroend

!macro customUnInstall
  ${Unless} ${Silent}
    ${If} ${FileExists} "$INSTDIR\data\*.*"
      MessageBox MB_YESNO|MB_ICONQUESTION \
        "Do you want to permanently delete your portable 'data' folder (Telegram login session, encrypted vault, settings, and cached files)?$\r$\n$\r$\nClick 'No' to keep your data folder intact." \
        IDYES removePortableData IDNO keepPortableData
      removePortableData:
        RMDir /r "$INSTDIR\data"
      keepPortableData:
    ${EndIf}
  ${EndUnless}
!macroend
