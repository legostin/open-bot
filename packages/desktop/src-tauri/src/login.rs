//! One-time sign-in tickets for the hub window: the app writes `ticket <t>` to the hub's stdin and opens
//! `<hub>/#desktop=<t>` (packages/core/src/desktop-login.ts, packages/web/src/lib/desktop.ts).

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;

/// 32 random bytes, base64url: 43 characters of [A-Za-z0-9_-].
pub fn new_ticket() -> String {
  let mut bytes = [0u8; 32];
  getrandom::fill(&mut bytes).expect("system random generator");
  URL_SAFE_NO_PAD.encode(bytes)
}

/// `base` without its fragment, plus `#desktop=<ticket>`.
pub fn with_ticket(base: &str, ticket: &str) -> String {
  let base = base.split('#').next().unwrap_or(base);
  format!("{base}#desktop={ticket}")
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn tickets_match_what_the_hub_accepts() {
    let a = new_ticket();
    assert_eq!(a.len(), 43);
    assert!(a.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    assert_ne!(a, new_ticket());
  }

  #[test]
  fn puts_the_ticket_in_the_fragment() {
    assert_eq!(with_ticket("http://localhost:8080/", "abc"), "http://localhost:8080/#desktop=abc");
    assert_eq!(with_ticket("http://localhost:8080/#old", "abc"), "http://localhost:8080/#desktop=abc");
  }
}
