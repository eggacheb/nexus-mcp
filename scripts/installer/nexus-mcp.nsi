; nexus-mcp 安装脚本（NSIS 3.11，与 Nexus 用的 Tauri bundler 同一份运行时）
; 正常由 `npm run package` 调用，并从命令行传 /DAPP_VERSION /DSTAGE_DIR /DOUT_FILE 进来。
; 传参路径不能带空格——NSIS 的 /D 不认引号。

Unicode true
!include "MUI2.nsh"

!ifndef APP_VERSION
  !define APP_VERSION "0.0.0"
!endif
!ifndef STAGE_DIR
  !define STAGE_DIR "build\package"
!endif
!ifndef OUT_FILE
  !define OUT_FILE "release\nexus-mcp-setup.exe"
!endif

!define APP_NAME "nexus-mcp"
!define APP_EXE "nexus-mcp.exe"
!define APP_SERVER "nexus-server.exe"
!define APP_EXECUTOR "nexus-executor.exe"
!define APP_PUBLISHER "nexus-mcp"
!define APP_ID "nexus-mcp"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}"

Name "${APP_NAME} ${APP_VERSION}"
OutFile "${OUT_FILE}"
; 按用户安装：不弹 UAC，装进 %LOCALAPPDATA%（与 Nexus 的 installMode=currentUser 一致）
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
InstallDirRegKey HKCU "Software\${APP_ID}" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma

VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "FileDescription" "${APP_NAME} 安装程序"
VIAddVersionKey "CompanyName" "${APP_PUBLISHER}"
VIAddVersionKey "LegalCopyright" "AGPL-3.0"

!define MUI_ABORTWARNING
!define MUI_ICON "..\..\assets\nexus-mcp.ico"
!define MUI_UNICON "..\..\assets\nexus-mcp.ico"
!define MUI_WELCOMEPAGE_TEXT "nexus-mcp 是给云端 AI 用的本地 MCP 服务。$\r$\n$\r$\n只装到当前用户目录，不需要管理员权限。首次启动会在安装目录生成 config.json 与 workspace。"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "现在启动 nexus-mcp（自动打开控制面板并常驻右下角托盘）"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

; 优先经托盘控制端口优雅退出（避免硬杀留孤儿隧道），缺失或超时再 taskkill 兜底
!macro StopRunningApp includeTunnel
  nsExec::Exec 'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command "$$f = Join-Path \"$INSTDIR\" \".tray-control.json\"; if (Test-Path $$f) { try { $$c = Get-Content $$f -Raw | ConvertFrom-Json; Invoke-RestMethod -Method Post -Uri (\"http://127.0.0.1:\" + $$c.port + \"/quit\") -Headers @{ \"X-Tray-Token\" = $$c.token } -ContentType \"application/json\" -Body \"{\\\"includeTunnel\\\":${includeTunnel}}\" -TimeoutSec 3 | Out-Null; Start-Sleep -Milliseconds 1500 } catch {} }"'
  nsExec::Exec 'taskkill /F /IM ${APP_EXE}'
  nsExec::Exec 'taskkill /F /IM ${APP_SERVER}'
  nsExec::Exec 'taskkill /F /IM ${APP_EXECUTOR}'
!macroend

Section "安装" SecInstall
  SetShellVarContext current

  ; 覆盖安装前先优雅停止托盘（保隧道不断），超时再兜底强杀
  !insertmacro StopRunningApp "false"

  SetOutPath "$INSTDIR"
  File /r "${STAGE_DIR}\*.*"

  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\卸载 ${APP_NAME}.lnk" "$INSTDIR\uninstall.exe"
  CreateShortCut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0

  WriteRegStr HKCU "Software\${APP_ID}" "InstallDir" "$INSTDIR"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" 95000
SectionEnd

Section "Uninstall"
  SetShellVarContext current

  ; 卸载前先优雅全停（连同受管隧道一并关闭），超时再兜底强杀
  !insertmacro StopRunningApp "true"

  Delete "$DESKTOP\${APP_NAME}.lnk"
  Delete "$SMSTARTUP\${APP_NAME}.lnk"
  RMDir /r "$SMPROGRAMS\${APP_NAME}"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\${APP_ID}"

  ; 只删程序文件与热切换/控制残留；config.json、oauth-store.json、sessions-store.json 与 workspace 属于用户数据，卸载不碰
  Delete "$INSTDIR\${APP_EXE}"
  Delete "$INSTDIR\${APP_SERVER}"
  Delete "$INSTDIR\${APP_EXECUTOR}"
  Delete "$INSTDIR\${APP_EXE}.prev"
  Delete "$INSTDIR\${APP_SERVER}.prev"
  Delete "$INSTDIR\${APP_EXECUTOR}.prev"
  Delete "$INSTDIR\${APP_EXE}.old"
  Delete "$INSTDIR\.tray-control.json"
  Delete "$INSTDIR\使用说明.txt"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
