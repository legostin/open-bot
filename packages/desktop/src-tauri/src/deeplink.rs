//! `owlbot://pair?hub=<url>&code=<code>`: the link the hub's Machines page offers to connect this computer.

use serde::Serialize;
use tauri::Url;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PairLink {
  pub hub: String,
  pub code: String,
}

pub fn parse(link: &Url) -> Option<PairLink> {
  if link.scheme() != "owlbot" {
    return None;
  }
  // owlbot://pair?… has "pair" as its host; owlbot:pair?… as its path.
  let what = link.host_str().unwrap_or_else(|| link.path()).trim_matches('/');
  if what != "pair" {
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

#[cfg(test)]
mod tests {
  use super::*;

  fn p(s: &str) -> Option<PairLink> {
    parse(&Url::parse(s).unwrap())
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
  }
}
