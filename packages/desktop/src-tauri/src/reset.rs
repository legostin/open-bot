//! "Reset Owlbot…": what the app and its hub keep on this computer goes — the hub's data (chats, agents, memory, the
//! vault, plugins, logs), the app's settings, this computer's machine pairing and the start-at-login entry. The CLI
//! logins in the user's home (Claude Code, Codex) stay: they belong to those tools, not to Owlbot.

use std::fs;
use std::io;
use std::path::Path;

/// Deletes the hub's data in `dir`. On Windows the installer puts the app into that same folder (its per-user default),
/// so the app's own files stay there: the executable, the uninstaller, the bundled hub (`app`) and the DLLs.
pub fn delete_hub_data(dir: &Path, exe: Option<&Path>) -> io::Result<()> {
  if !dir.exists() {
    return Ok(());
  }
  let installed_here = exe.and_then(|e| e.parent()).is_some_and(|p| same_dir(p, dir));
  let exe_name = exe.and_then(|e| e.file_name()).map(|n| n.to_string_lossy().to_lowercase());
  for entry in fs::read_dir(dir)? {
    let entry = entry?;
    let name = entry.file_name().to_string_lossy().to_lowercase();
    if installed_here && (exe_name.as_deref() == Some(name.as_str()) || is_install_file(&name)) {
      continue;
    }
    if entry.file_type()?.is_dir() {
      fs::remove_dir_all(entry.path())?;
    } else {
      fs::remove_file(entry.path())?;
    }
  }
  if !installed_here {
    fs::remove_dir(dir)?;
  }
  Ok(())
}

fn is_install_file(name: &str) -> bool {
  name == "uninstall.exe" || name == "app" || name == "resources" || name.ends_with(".dll")
}

fn same_dir(a: &Path, b: &Path) -> bool {
  match (dunce::canonicalize(a), dunce::canonicalize(b)) {
    (Ok(a), Ok(b)) => a == b,
    _ => false,
  }
}

/// Removes a folder or a file that may already be gone.
pub fn remove(path: &Path) -> io::Result<()> {
  let r = if path.is_dir() { fs::remove_dir_all(path) } else { fs::remove_file(path) };
  match r {
    Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
    other => other,
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::path::PathBuf;

  fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("owl-reset-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
  }

  fn fill(dir: &Path) {
    fs::write(dir.join("owlbot.db"), "x").unwrap();
    fs::write(dir.join("vault.db"), "x").unwrap();
    fs::create_dir_all(dir.join("workspaces/assistant")).unwrap();
    fs::write(dir.join("workspaces/assistant/notes.md"), "x").unwrap();
  }

  #[test]
  fn deletes_a_data_folder_entirely() {
    let dir = tmp("data");
    fill(&dir);
    delete_hub_data(&dir, Some(Path::new("/Applications/Owlbot.app/Contents/MacOS/Owlbot"))).unwrap();
    assert!(!dir.exists());
  }

  #[test]
  fn keeps_the_app_when_it_is_installed_in_the_data_folder() {
    let dir = tmp("install");
    fill(&dir);
    fs::write(dir.join("Owlbot.exe"), "exe").unwrap();
    fs::write(dir.join("uninstall.exe"), "exe").unwrap();
    fs::write(dir.join("WebView2Loader.dll"), "dll").unwrap();
    fs::create_dir_all(dir.join("app/runtime")).unwrap();
    delete_hub_data(&dir, Some(&dir.join("Owlbot.exe"))).unwrap();
    let mut left: Vec<String> = fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    left.sort();
    assert_eq!(left, vec!["Owlbot.exe", "WebView2Loader.dll", "app", "uninstall.exe"]);
  }

  #[test]
  fn a_missing_folder_is_fine() {
    let dir = std::env::temp_dir().join(format!("owl-reset-{}-none", std::process::id()));
    assert!(delete_hub_data(&dir, None).is_ok());
    assert!(remove(&dir.join("nothing")).is_ok());
  }
}
