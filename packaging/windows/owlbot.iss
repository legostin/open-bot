; Owlbot for Windows: a per-user install (no admin rights) of the staged app (packaging/desktop/stage.mjs) with its
; own Node, the tray app (Owlbot.exe) and a Run value that starts it at sign-in. Built by packaging/windows/build.mjs:
;   ISCC /DAppVersion=x.y.z /DStageDir=... /DOutputDir=... /DMessagesFile=... /DIconFile=... owlbot.iss
; Options: /PORT=18080 writes the hub port to the data dir's desktop.json (for a second hub next to another one);
; /NOSTART leaves the tray stopped after a silent install (CI starts it itself).

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{A4A4B056-D67F-4161-9800-3232E1B068AA}
AppName=Owlbot
AppVersion={#AppVersion}
AppVerName=Owlbot {#AppVersion}
AppPublisher=Owlbot
VersionInfoVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\Owlbot
DefaultGroupName=Owlbot
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=owlbot-setup-{#AppVersion}-x64
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\Owlbot.exe
UninstallDisplayName=Owlbot
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
SetupLogging=yes
ShowLanguageDialog=auto

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"

#include MessagesFile

[Tasks]
Name: "autostart"; Description: "{cm:setup_autostart}"

[InstallDelete]
; Upgrades replace the app's code wholesale; the data dir is elsewhere and is kept.
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\packages"
Type: filesandordirs; Name: "{app}\plugins"
Type: filesandordirs; Name: "{app}\agents"
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\packaging"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Owlbot"; Filename: "{app}\Owlbot.exe"; IconFilename: "{app}\owlbot.ico"
; Starts the tray without opening the browser; [Run] opens it through Explorer after a silent install.
Name: "{app}\Owlbot (background)"; Filename: "{app}\Owlbot.exe"; Parameters: "--background"; IconFilename: "{app}\owlbot.ico"

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "Owlbot"; ValueData: """{app}\Owlbot.exe"" --background"; Flags: uninsdeletevalue; Tasks: autostart

[Run]
; Through Explorer, not as Setup's child: processes Setup starts inherit its redirection guard, and the hub with the
; CLIs it runs would then not follow junctions (pnpm installs in a workspace, say) until the next sign-in.
Filename: "{win}\explorer.exe"; Parameters: """{app}\Owlbot.exe"""; Description: "{cm:setup_open}"; Flags: nowait postinstall skipifsilent
Filename: "{win}\explorer.exe"; Parameters: """{app}\Owlbot (background).lnk"""; Flags: nowait; Check: StartAfterSilentInstall

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
const
  RunKey = 'Software\Microsoft\Windows\CurrentVersion\Run';

function DataDir: String;
begin
  Result := ExpandConstant('{localappdata}\Owlbot');
end;

function HasSwitch(Name: String): Boolean;
var
  I: Integer;
begin
  Result := False;
  for I := 1 to ParamCount do
    if CompareText(ParamStr(I), Name) = 0 then
      Result := True;
end;

function StartAfterSilentInstall: Boolean;
begin
  Result := WizardSilent and not HasSwitch('/NOSTART');
end;

{ Asks a running tray app to stop the hub and quit, and waits for it. }
procedure StopRunning;
var
  Code: Integer;
  Exe: String;
begin
  Exe := ExpandConstant('{app}\Owlbot.exe');
  if FileExists(Exe) then
    Exec(Exe, '--quit', '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopRunning;
  Result := '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Port: String;
begin
  { Before the files: [Run] starts the tray before ssPostInstall, and it reads desktop.json at once. }
  if CurStep = ssInstall then
  begin
    Port := ExpandConstant('{param:PORT|}');
    if Port <> '' then
    begin
      ForceDirectories(DataDir);
      SaveStringToFile(DataDir + '\desktop.json', '{ "port": ' + IntToStr(StrToIntDef(Port, 8080)) + ' }' + #13#10, False);
    end;
  end;
  if (CurStep = ssPostInstall) and not WizardIsTaskSelected('autostart') then
    RegDeleteValue(HKEY_CURRENT_USER, RunKey, 'Owlbot');
end;

function InitializeUninstall: Boolean;
begin
  StopRunning;
  Result := True;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
  begin
    RegDeleteValue(HKEY_CURRENT_USER, RunKey, 'Owlbot');
    { Chats, agents and the vault stay unless the user says otherwise; a silent uninstall always keeps them. }
    if (not UninstallSilent) and DirExists(DataDir) then
      if MsgBox(FmtMessage(CustomMessage('setup_deleteData'), [DataDir]), mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
        DelTree(DataDir, True, True, True);
  end;
end;
