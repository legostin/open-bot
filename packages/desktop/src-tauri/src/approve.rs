//! Approval cards answered in the app. The card in the hub window links `<scheme>://approval?id=…&decision=…`
//! (deeplink.rs, taken from that window only). A yes needs the person: Touch ID, or their Mac password, showing what
//! the card asks as the hub tells it (never as the page does). Then the app answers with the key it gave the hub over
//! its stdin (packages/core/src/desktop-login.ts); the page never sees that key, so nothing running there can say
//! yes for the person. The page hears how it went through an `owlbot-desktop` event.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::app::AppState;
use crate::i18n::texts;
use crate::window;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Answer {
  pub id: String,
  pub approve: bool,
  pub remember: bool,
}

enum Outcome {
  Done,
  Cancelled,
  Failed(String),
}

/// Answers the card, then tells the page in the hub window how it went. Runs off the main thread.
pub fn run(app: &AppHandle, answer: Answer) {
  let outcome = match send(app, &answer) {
    Ok(o) => o,
    Err(e) => Outcome::Failed(e),
  };
  let (name, error) = match &outcome {
    Outcome::Done => ("done", None),
    Outcome::Cancelled => ("cancelled", None),
    Outcome::Failed(e) => ("failed", Some(e.clone())),
  };
  let detail = json!({ "type": "approval", "id": answer.id, "outcome": name, "error": error });
  if let Some(w) = app.get_webview_window(window::MAIN) {
    let _ = w.eval(format!("window.dispatchEvent(new CustomEvent('owlbot-desktop', {{ detail: {detail} }}))"));
  }
}

fn send(app: &AppHandle, a: &Answer) -> Result<Outcome, String> {
  let st = app.state::<AppState>();
  let port = st.paths.hub_ports().first().copied().ok_or("no port")?;
  let hub = Hub { port, key: &st.approver, lang: texts().lang() };
  let path = format!("/api/desktop/approvals/{}", a.id);
  if a.approve {
    let card = hub.call("GET", &path, None)?;
    if card["status"] != "pending" {
      return Ok(Outcome::Done);
    }
    let reason = card["reason"].as_str().unwrap_or_default();
    if !confirm(reason)? {
      return Ok(Outcome::Cancelled);
    }
  }
  let body = json!({ "decision": if a.approve { "approve" } else { "deny" }, "remember": a.remember });
  hub.call("POST", &path, Some(&body))?;
  Ok(Outcome::Done)
}

struct Hub<'a> {
  port: u16,
  key: &'a str,
  lang: &'a str,
}

impl Hub<'_> {
  /// One request to the hub on this computer; its JSON answer, or its error text.
  fn call(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value, String> {
    let unreachable = |_| texts().t("approval.unreachable");
    let mut s = TcpStream::connect(("127.0.0.1", self.port)).map_err(unreachable)?;
    s.set_read_timeout(Some(Duration::from_secs(20))).map_err(unreachable)?;
    let body = body.map(|b| b.to_string());
    let mut req = format!(
      "{method} {path} HTTP/1.1\r\nHost: localhost:{}\r\nX-Owlbot-Approver: {}\r\nAccept-Language: {}\r\nConnection: close\r\n",
      self.port, self.key, self.lang
    );
    if let Some(b) = &body {
      req.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", b.len()));
    }
    req.push_str("\r\n");
    req.push_str(body.as_deref().unwrap_or_default());
    s.write_all(req.as_bytes()).map_err(unreachable)?;
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).map_err(unreachable)?;
    parse_response(&String::from_utf8_lossy(&raw))
  }
}

/// The status and JSON body of an HTTP/1.1 answer sent with a length (the hub's are); an error answer's text.
fn parse_response(raw: &str) -> Result<Value, String> {
  let (head, body) = raw.split_once("\r\n\r\n").ok_or_else(|| texts().t("approval.unreachable"))?;
  let status: u16 = head.split_whitespace().nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
  let value: Value = serde_json::from_str(body).unwrap_or(Value::Null);
  if (200..300).contains(&status) {
    Ok(value)
  } else {
    Err(value["error"].as_str().map(str::to_string).unwrap_or_else(|| format!("HTTP {status}")))
  }
}

/// Asks the person to confirm with Touch ID (or their Mac password): true when they did, false when they backed out.
#[cfg(target_os = "macos")]
fn confirm(reason: &str) -> Result<bool, String> {
  use block2::RcBlock;
  use objc2::rc::Retained;
  use objc2::runtime::{AnyClass, AnyObject, Bool};
  use objc2::msg_send;
  use objc2_foundation::{NSError, NSString};
  use std::sync::mpsc;

  #[link(name = "LocalAuthentication", kind = "framework")]
  extern "C" {}

  /// LAPolicyDeviceOwnerAuthentication: Touch ID, else the account password.
  const OWNER: isize = 2;
  /// LAError: userCancel, systemCancel, appCancel, userFallback.
  const BACKED_OUT: [isize; 4] = [-2, -4, -9, -3];

  let class = AnyClass::get(c"LAContext").ok_or("LocalAuthentication is not available")?;
  let context: Retained<AnyObject> = unsafe { msg_send![class, new] };
  let (tx, rx) = mpsc::channel::<(bool, isize)>();
  let reply = RcBlock::new(move |ok: Bool, error: *mut NSError| {
    let code = if error.is_null() { 0 } else { unsafe { (*error).code() } };
    let _ = tx.send((ok.as_bool(), code));
  });
  let reason = NSString::from_str(reason);
  unsafe {
    let _: () = msg_send![&*context, evaluatePolicy: OWNER, localizedReason: &*reason, reply: &*reply];
  }
  let (ok, code) = rx.recv_timeout(Duration::from_secs(600)).map_err(|_| texts().t("approval.noAnswer"))?;
  if ok {
    Ok(true)
  } else if BACKED_OUT.contains(&code) {
    Ok(false)
  } else {
    Err(texts().f("approval.authFailed", &[("code", &code.to_string())]))
  }
}

#[cfg(not(target_os = "macos"))]
fn confirm(_reason: &str) -> Result<bool, String> {
  Err(texts().t("approval.unsupported"))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn reads_the_hubs_answers() {
    let ok = "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 34\r\n\r\n{\"id\":\"a_1\",\"status\":\"pending\"}";
    assert_eq!(parse_response(ok).unwrap()["status"], "pending");
    let gone = "HTTP/1.1 409 Conflict\r\ncontent-length: 40\r\n\r\n{\"error\":\"This approval has been handled\"}";
    assert_eq!(parse_response(gone).unwrap_err(), "This approval has been handled");
    assert_eq!(parse_response("HTTP/1.1 500 x\r\n\r\n").unwrap_err(), "HTTP 500");
  }
}
