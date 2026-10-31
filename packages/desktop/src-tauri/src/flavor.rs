//! The build's flavor: the app itself, or the test build (`npm run package:desktop -- --test`), which installs next to
//! it as "Piomio Test" (identifier ai.piomio.test) with its own data dir, node pairing, start-at-login entry and the
//! ports right after the app's (41790, 41791, 41799), and says that it is a test build in its windows and tray.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Flavor {
  pub test: bool,
  /// The product name: window titles, the tray, the data dir, the Windows Run value.
  pub name: String,
  /// The bundle identifier: the macOS LaunchAgent label.
  pub id: String,
  /// The hub's default port (console +1, egress proxy +9), unless desktop.json says otherwise.
  pub port: u16,
}

impl Flavor {
  pub fn of(identifier: &str, name: &str) -> Flavor {
    let test = identifier.ends_with(".test");
    Flavor { test, name: name.to_string(), id: identifier.to_string(), port: if test { 41790 } else { 41780 } }
  }

  /// The deep-link scheme the bundle registers (build.mjs): `piomio://pair?…` or `piomio-test://pair?…`.
  pub fn scheme(&self) -> &'static str {
    if self.test {
      "piomio-test"
    } else {
      "piomio"
    }
  }

  /// Where piomio-node keeps its pairing (in the home dir).
  pub fn node_home_dir(&self) -> &'static str {
    if self.test {
      ".piomio-node-test"
    } else {
      ".piomio-node"
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_test_build_keeps_apart() {
    let app = Flavor::of("ai.piomio.app", "Piomio");
    assert_eq!((app.test, app.port, app.node_home_dir()), (false, 41780, ".piomio-node"));
    let test = Flavor::of("ai.piomio.test", "Piomio Test");
    assert_eq!((test.test, test.port, test.node_home_dir()), (true, 41790, ".piomio-node-test"));
    assert_eq!((app.scheme(), test.scheme()), ("piomio", "piomio-test"));
  }
}
