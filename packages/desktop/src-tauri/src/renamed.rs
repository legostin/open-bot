//! Piomio was Owlbot until 2026-10-31. An Owlbot install carries on after the upgrade: its hub data stays where it is
//! (agents' messages and sessions hold absolute paths into it; the hub renames owlbot.db itself), its app settings and
//! node pairing move to the new names, and its start-at-login entry goes (the app writes its own, autostart.rs).

use std::path::{Path, PathBuf};

use crate::flavor::Flavor;

struct Old {
  /// The product name: the data dir, the Windows Run value.
  name: &'static str,
  /// The bundle identifier: the config dir, the macOS LaunchAgent.
  id: &'static str,
  node_home: &'static str,
}

fn old(flavor: &Flavor) -> Old {
  if flavor.test {
    Old { name: "Owlbot Test", id: "ai.owlbot.test", node_home: ".owlbot-node-test" }
  } else {
    Old { name: "Owlbot", id: "ai.owlbot.app", node_home: ".owlbot-node" }
  }
}

/// The hub's data dir under `root`: Owlbot's when only that one is there.
pub fn hub_data(root: &Path, flavor: &Flavor) -> PathBuf {
  let new = root.join(&flavor.name);
  let old = root.join(old(flavor).name);
  if !new.exists() && old.exists() {
    old
  } else {
    new
  }
}

/// Owlbot's app settings (the config dir's sibling named by its bundle id) and node pairing move to the new places.
pub fn adopt(flavor: &Flavor, config_dir: &Path, node_home: Option<&Path>) {
  let o = old(flavor);
  if let Some(parent) = config_dir.parent() {
    take(&parent.join(o.id), config_dir);
  }
  if let Some(home) = node_home {
    if let Some(parent) = home.parent() {
      take(&parent.join(o.node_home), home);
    }
  }
}

fn take(old: &Path, new: &Path) {
  if new.exists() || !old.exists() {
    return;
  }
  if let Err(e) = std::fs::rename(old, new) {
    eprintln!("piomio: {} -> {}: {e}", old.display(), new.display());
  }
}

/// Owlbot's start-at-login entry, which would start the old app (or, once it is gone, only delete itself).
#[cfg(target_os = "macos")]
pub fn remove_old_autostart(flavor: &Flavor) {
  let home = std::env::var("HOME").unwrap_or_default();
  let _ = std::fs::remove_file(Path::new(&home).join(format!("Library/LaunchAgents/{}.plist", old(flavor).id)));
}

#[cfg(windows)]
pub fn remove_old_autostart(flavor: &Flavor) {
  use winreg::enums::HKEY_CURRENT_USER;
  use winreg::RegKey;
  if let Ok(key) = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(r"Software\Microsoft\Windows\CurrentVersion\Run", winreg::enums::KEY_SET_VALUE) {
    let _ = key.delete_value(old(flavor).name);
  }
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn remove_old_autostart(_flavor: &Flavor) {}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn an_owlbot_install_carries_on() {
    let root = std::env::temp_dir().join(format!("piomio-renamed-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let app = Flavor::of("ai.piomio.app", "Piomio");
    // A new install: Piomio's own dirs.
    assert_eq!(hub_data(&root, &app), root.join("Piomio"));
    std::fs::create_dir_all(root.join("Owlbot")).unwrap();
    std::fs::create_dir_all(root.join("ai.owlbot.app")).unwrap();
    std::fs::write(root.join("ai.owlbot.app").join("settings.json"), "{}").unwrap();
    std::fs::create_dir_all(root.join(".owlbot-node")).unwrap();
    // An Owlbot install: the hub data stays, settings and pairing move.
    assert_eq!(hub_data(&root, &app), root.join("Owlbot"));
    adopt(&app, &root.join("ai.piomio.app"), Some(&root.join(".piomio-node")));
    assert!(root.join("ai.piomio.app").join("settings.json").exists() && !root.join("ai.owlbot.app").exists());
    assert!(root.join(".piomio-node").exists() && !root.join(".owlbot-node").exists());
    // Once Piomio has its own data dir, that one wins; the test build keeps to its own names.
    std::fs::create_dir_all(root.join("Piomio")).unwrap();
    assert_eq!(hub_data(&root, &app), root.join("Piomio"));
    assert_eq!(hub_data(&root, &Flavor::of("ai.piomio.test", "Piomio Test")), root.join("Piomio Test"));
    std::fs::remove_dir_all(&root).unwrap();
  }
}
