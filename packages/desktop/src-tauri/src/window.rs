//! Two windows: "main" shows the hub's own web UI (no app commands), "setup" the app's own screens (ui/). Links that
//! leave the hub's origin open in the system browser; the hub's own downloads go into the Downloads folder; closing
//! the hub window keeps the app in the tray.

use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder, Window, WindowEvent};
use tauri_plugin_opener::OpenerExt;

use crate::app::AppState;

pub const MAIN: &str = "main";
pub const SETUP: &str = "setup";

pub fn same_origin(a: &Url, b: &Url) -> bool {
  a.scheme() == b.scheme() && a.host_str() == b.host_str() && a.port_or_known_default() == b.port_or_known_default()
}

/// The app's own pages: tauri://localhost on macOS, http(s)://tauri.localhost on Windows.
pub fn is_local(u: &Url) -> bool {
  u.scheme() == "tauri" || u.host_str() == Some("tauri.localhost")
}

/// Shows the hub window when it exists; false when it has to be opened first.
pub fn show_main(app: &AppHandle) -> bool {
  let Some(w) = app.get_webview_window(MAIN) else { return false };
  let _ = w.show();
  let _ = w.unminimize();
  let _ = w.set_focus();
  dock(app, true);
  true
}

pub fn open_main(app: &AppHandle, url: Url) -> tauri::Result<()> {
  if show_main(app) {
    return Ok(());
  }
  let origin = url.clone();
  let hub = url.clone();
  let browser = app.clone();
  let popups = app.clone();
  let flavor = app.state::<AppState>().paths.flavor.clone();
  let scheme = flavor.scheme();
  // The hub's settings page offers "Quit" and "Reset Owlbot…" when it runs in this window (deeplink.rs).
  let hello = format!("window.owlbotDesktop = Object.freeze({{ scheme: {scheme:?}, test: {} }});", flavor.test);
  WebviewWindowBuilder::new(app, MAIN, WebviewUrl::External(url))
    .title(&app.package_info().name)
    .initialization_script(hello)
    .inner_size(1200.0, 820.0)
    .min_inner_size(420.0, 520.0)
    .on_navigation(move |u| {
      if same_origin(u, &origin) || u.scheme() == "about" || u.scheme() == "blob" {
        return true;
      }
      if u.scheme() == scheme {
        crate::app::on_window_link(&browser, u);
        return false;
      }
      let _ = browser.opener().open_url(u.as_str(), None::<&str>);
      false
    })
    .on_new_window(move |u, _| {
      let _ = popups.opener().open_url(u.as_str(), None::<&str>);
      NewWindowResponse::Deny
    })
    // The media viewer's download button: WebKit saves the file into Downloads under a free name, and the page hears
    // when it is there (state/viewer.ts). Only the hub's own files.
    .on_download(move |webview, event| match event {
      DownloadEvent::Requested { url, .. } => same_origin(&url, &hub),
      DownloadEvent::Finished { path, success, .. } => {
        let name = path.as_ref().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let detail = serde_json::json!({ "type": "download", "ok": success, "name": name });
        let _ = webview.eval(format!("window.dispatchEvent(new CustomEvent('owlbot-desktop', {{ detail: {detail} }}))"));
        true
      }
      _ => true,
    })
    .build()?;
  dock(app, true);
  Ok(())
}

/// The setup window, reloaded when it is already open so it shows the current state.
pub fn open_setup(app: &AppHandle) -> tauri::Result<()> {
  if let Some(w) = app.get_webview_window(SETUP) {
    w.eval("location.reload()")?;
    w.show()?;
    w.set_focus()?;
  } else {
    WebviewWindowBuilder::new(app, SETUP, WebviewUrl::App("index.html".into()))
      .title(&app.package_info().name)
      .inner_size(560.0, 660.0)
      .resizable(false)
      .center()
      .on_navigation(is_local)
      .build()?;
  }
  dock(app, true);
  Ok(())
}

pub fn close_setup(app: &AppHandle) {
  if let Some(w) = app.get_webview_window(SETUP) {
    let _ = w.close();
  }
}

/// Drops the hub window (its page belongs to the previous mode or hub).
pub fn close_main(app: &AppHandle) {
  if let Some(w) = app.get_webview_window(MAIN) {
    let _ = w.destroy();
  }
}

/// Closing the hub window only hides it; closing the setup window before anything was chosen quits.
pub fn on_event(window: &Window, event: &WindowEvent) {
  let app = window.app_handle();
  match event {
    WindowEvent::CloseRequested { api, .. } if window.label() == MAIN => {
      api.prevent_close();
      let _ = window.hide();
      hide_dock_if_idle(app);
    }
    WindowEvent::Destroyed if window.label() == SETUP => {
      let first_run = app.try_state::<AppState>().map(|s| s.settings.lock().unwrap().mode.is_none()).unwrap_or(true);
      if let Some(s) = app.try_state::<AppState>() {
        *s.reset.lock().unwrap() = false;
      }
      if first_run {
        app.exit(0);
      } else {
        hide_dock_if_idle(app);
      }
    }
    _ => {}
  }
}

fn hide_dock_if_idle(app: &AppHandle) {
  let visible = [MAIN, SETUP].iter().any(|l| app.get_webview_window(l).and_then(|w| w.is_visible().ok()).unwrap_or(false));
  if !visible {
    dock(app, false);
  }
}

/// macOS: a Dock icon only while a window is open; the menu bar icon stays.
pub fn dock(app: &AppHandle, visible: bool) {
  #[cfg(target_os = "macos")]
  let _ = app.set_activation_policy(if visible { tauri::ActivationPolicy::Regular } else { tauri::ActivationPolicy::Accessory });
  #[cfg(not(target_os = "macos"))]
  let _ = (app, visible);
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn compares_origins() {
    let hub = Url::parse("http://localhost:8080/#desktop=x").unwrap();
    assert!(same_origin(&Url::parse("http://localhost:8080/chat").unwrap(), &hub));
    assert!(!same_origin(&Url::parse("http://localhost:8081/").unwrap(), &hub));
    assert!(!same_origin(&Url::parse("https://example.com/").unwrap(), &hub));
    assert!(same_origin(&Url::parse("https://bot.example.com/x").unwrap(), &Url::parse("https://bot.example.com:443/").unwrap()));
  }

  #[test]
  fn knows_its_own_pages() {
    assert!(is_local(&Url::parse("tauri://localhost/index.html").unwrap()));
    assert!(is_local(&Url::parse("http://tauri.localhost/index.html").unwrap()));
    assert!(!is_local(&Url::parse("http://localhost:8080/").unwrap()));
  }
}
