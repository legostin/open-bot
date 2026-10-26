//! The AppleScript build of Owlbot (on main before this app) ran the hub from a LaunchAgent of its own (ai.owlbot.hub,
//! same data dir, same port). The app runs the hub itself now, so that agent goes before the app starts its hub.

use std::path::Path;
use std::process::Command;

pub fn remove_old_hub_agent() {
  let home = std::env::var("HOME").unwrap_or_default();
  let plist = Path::new(&home).join("Library/LaunchAgents/ai.owlbot.hub.plist");
  if !plist.exists() {
    return;
  }
  let uid = unsafe { libc::getuid() };
  let _ = Command::new("launchctl").args(["bootout", &format!("gui/{uid}/ai.owlbot.hub")]).status();
  let _ = std::fs::remove_file(plist);
}
