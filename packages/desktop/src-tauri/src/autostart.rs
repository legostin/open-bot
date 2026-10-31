//! Start at login with `--background` (no window): a LaunchAgent on macOS (labelled with the bundle id), the HKCU
//! Run value named after the product on Windows (the uninstaller of the Tauri bundle removes it by that name). Both point at the app's current path;
//! the app applies its setting at every start, which also repairs them after a move or an upgrade.

use std::io;
use std::path::Path;

use crate::flavor::Flavor;

pub const ARG: &str = "--background";

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn xml(s: &str) -> String {
  s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// The macOS LaunchAgent: a small guard starts the app when it is still there and deletes this plist when the app
/// was moved to the Trash, so nothing is left failing at every login.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn launch_agent(label: &str, exe: &str, plist: &str) -> String {
  let guard = format!(r#"if [ -x "$1" ]; then exec "$1" {ARG}; fi; rm -f "$2""#);
  format!(
    r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{label}</string>
  <key>AssociatedBundleIdentifiers</key><array><string>{label}</string></array>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>-c</string><string>{}</string><string>Piomio</string><string>{}</string><string>{}</string></array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
"#,
    xml(&guard),
    xml(exe),
    xml(plist),
    label = xml(label),
  )
}

#[cfg(target_os = "macos")]
pub fn set(flavor: &Flavor, exe: &Path, on: bool) -> io::Result<()> {
  use std::fs;
  let plist = std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(format!("Library/LaunchAgents/{}.plist", flavor.id));
  if !on {
    return match fs::remove_file(&plist) {
      Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
      _ => Ok(()),
    };
  }
  let body = launch_agent(&flavor.id, &exe.to_string_lossy(), &plist.to_string_lossy());
  if fs::read_to_string(&plist).ok().as_deref() == Some(body.as_str()) {
    return Ok(());
  }
  fs::create_dir_all(plist.parent().expect("LaunchAgents folder"))?;
  // launchd reads it at the next login; the app already runs now.
  fs::write(&plist, body)
}

#[cfg(windows)]
pub fn set(flavor: &Flavor, exe: &Path, on: bool) -> io::Result<()> {
  use winreg::enums::HKEY_CURRENT_USER;
  use winreg::RegKey;
  let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(r"Software\Microsoft\Windows\CurrentVersion\Run")?;
  if on {
    key.set_value(&flavor.name, &format!("\"{}\" {ARG}", exe.display()))
  } else {
    match key.delete_value(&flavor.name) {
      Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
      _ => Ok(()),
    }
  }
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn set(_flavor: &Flavor, _exe: &Path, _on: bool) -> io::Result<()> {
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_launch_agent_starts_the_app_or_removes_itself() {
    let a = launch_agent("ai.piomio.app", "/Applications/open & bot.app/Contents/MacOS/Piomio", "/Users/u/Library/LaunchAgents/ai.piomio.app.plist");
    assert!(a.contains("<string>/Applications/open &amp; bot.app/Contents/MacOS/Piomio</string>"));
    assert!(a.contains(r#"exec "$1" --background; fi; rm -f "$2""#));
    assert!(a.contains("<key>AssociatedBundleIdentifiers</key>"));
    assert!(!a.contains("KeepAlive"));
    assert!(launch_agent("ai.piomio.test", "/x", "/y").contains("<key>Label</key><string>ai.piomio.test</string>"));
  }
}
