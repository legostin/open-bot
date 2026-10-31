//! macOS gives a GUI app a bare PATH (/usr/bin:/bin:/usr/sbin:/sbin), so brain CLIs installed with Homebrew, npm or
//! the Claude installer are not found. The hub reads the login shell's PATH itself (packages/core/src/user-path.ts);
//! for piomio-node the app asks the login shell once and passes it on.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

/// Marks the PATH in the shell's output: startup files may print other text.
const MARK: &str = "__PIOMIO_PATH__";

pub fn between_marks(out: &str) -> Option<&str> {
  let start = out.find(MARK)? + MARK.len();
  let end = out[start..].find(MARK)? + start;
  Some(&out[start..end]).filter(|p| !p.is_empty())
}

/// The folders of `first`, then those of `then` not seen yet.
pub fn merge(first: &str, then: &str) -> String {
  let mut seen: Vec<&str> = Vec::new();
  for p in first.split(':').chain(then.split(':')) {
    if !p.is_empty() && !seen.contains(&p) {
      seen.push(p);
    }
  }
  seen.join(":")
}

pub fn fallback(home: &str) -> String {
  format!("{home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
}

#[cfg(target_os = "macos")]
pub fn login_path() -> String {
  use std::io::Read;
  use std::process::{Command, Stdio};
  use std::time::{Duration, Instant};

  let home = std::env::var("HOME").unwrap_or_default();
  let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
  let script = format!("printf '{MARK}%s{MARK}' \"$PATH\"");
  let found = (|| {
    let mut child = Command::new(&shell).args(["-ilc", &script]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let t0 = Instant::now();
    loop {
      match child.try_wait() {
        Ok(Some(_)) => break,
        Ok(None) if t0.elapsed() < Duration::from_secs(5) => std::thread::sleep(Duration::from_millis(50)),
        _ => {
          let _ = child.kill();
          let _ = child.wait();
          return None;
        }
      }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    between_marks(&out).map(str::to_string)
  })();
  match found {
    Some(path) => merge(&path, &fallback(&home)),
    None => fallback(&home),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn finds_the_path_among_shell_chatter() {
    assert_eq!(between_marks("Welcome!\n__PIOMIO_PATH__/a:/b__PIOMIO_PATH__"), Some("/a:/b"));
    assert_eq!(between_marks("no marks"), None);
    assert_eq!(between_marks("__PIOMIO_PATH____PIOMIO_PATH__"), None);
  }

  #[test]
  fn merges_without_duplicates() {
    assert_eq!(merge("/a:/usr/bin", "/usr/bin:/bin"), "/a:/usr/bin:/bin");
  }

  #[cfg(target_os = "macos")]
  #[test]
  fn asks_the_login_shell() {
    assert!(login_path().split(':').any(|p| p == "/usr/bin"));
  }
}
