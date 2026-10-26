//! `owlbot://pair?hub=<url>&code=<code>`: the link the hub's Machines page offers to connect this computer. The test
//! build's scheme is `owlbot-test` (flavor.rs). The hub window also uses `<scheme>://reset` and `<scheme>://quit` for
//! its "This app" settings; those are only taken from that window, never from the system (`window_action`).

use serde::Serialize;
use tauri::Url;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PairLink {
  pub hub: String,
  pub code: String,
}

/// What the link asks for: `pair` in owlbot://pair?… (its host) and in owlbot:pair?… (its path).
fn what(link: &Url) -> &str {
  link.host_str().unwrap_or_else(|| link.path()).trim_matches('/')
}

pub fn parse(link: &Url, scheme: &str) -> Option<PairLink> {
  if link.scheme() != scheme || what(link) != "pair" {
    return None;
  }
  let (mut hub, mut code) = (None, None);
  for (k, v) in link.query_pairs() {
    match k.as_ref() {
      "hub" => hub = Some(v.into_owned()),
      "code" => code = Some(v.into_owned()),
      _ => {}
    }
  }
  let (hub, code) = (hub?, code?);
  let url = Url::parse(&hub).ok()?;
  if url.scheme() != "http" && url.scheme() != "https" {
    return None;
  }
  if code.is_empty() || code.len() > 64 || !code.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
    return None;
  }
  Some(PairLink { hub, code })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowAction {
  Reset,
  Quit,
}

/// `<scheme>://reset` or `<scheme>://quit` from the hub window's settings.
pub fn window_action(link: &Url, scheme: &str) -> Option<WindowAction> {
  if link.scheme() != scheme {
    return None;
  }
  match what(link) {
    "reset" => Some(WindowAction::Reset),
    "quit" => Some(WindowAction::Quit),
    _ => None,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn p(s: &str) -> Option<PairLink> {
    parse(&Url::parse(s).unwrap(), "owlbot")
  }

  #[test]
  fn reads_a_pairing_link() {
    assert_eq!(
      p("owlbot://pair?hub=https%3A%2F%2Fbot.example.com&code=AB12CD34"),
      Some(PairLink { hub: "https://bot.example.com".into(), code: "AB12CD34".into() })
    );
    assert_eq!(p("owlbot:pair?hub=http://192.168.1.5:8080&code=x-1").map(|l| l.hub), Some("http://192.168.1.5:8080".into()));
  }

  #[test]
  fn refuses_anything_else() {
    assert_eq!(p("owlbot://other?hub=https://a.b&code=x"), None);
    assert_eq!(p("owlbot://pair?hub=file:///etc/passwd&code=x"), None);
    assert_eq!(p("owlbot://pair?hub=https://a.b"), None);
    assert_eq!(p("owlbot://pair?hub=https://a.b&code=a%20b"), None);
    assert_eq!(p("https://pair?hub=https://a.b&code=x"), None);
    assert_eq!(p("owlbot-test://pair?hub=https://a.b&code=x"), None);
  }

  #[test]
  fn the_test_build_takes_its_own_links() {
    let u = Url::parse("owlbot-test://pair?hub=https://a.b&code=x").unwrap();
    assert_eq!(parse(&u, "owlbot-test").map(|l| l.code), Some("x".into()));
  }

  #[test]
  fn reads_the_hub_window_actions() {
    let a = |s: &str, scheme: &str| window_action(&Url::parse(s).unwrap(), scheme);
    assert_eq!(a("owlbot://reset", "owlbot"), Some(WindowAction::Reset));
    assert_eq!(a("owlbot-test://quit", "owlbot-test"), Some(WindowAction::Quit));
    assert_eq!(a("owlbot://reset", "owlbot-test"), None);
    assert_eq!(a("owlbot://pair?hub=https://a.b&code=x", "owlbot"), None);
  }
}
