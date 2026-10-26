//! Commands for the app's own screens (window "setup" only: capabilities/setup.json).

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::app::{self, AppState, UiError};
use crate::deeplink::PairLink;
use crate::i18n::texts;
use crate::settings::{self, Existing, Mode};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiState {
  lang: &'static str,
  /// The test build: the screens say so.
  test: bool,
  /// "Reset Owlbot…" waits for a confirmation.
  reset: bool,
  mode: Option<Mode>,
  starting: bool,
  existing: Option<Existing>,
  link: Option<PairLink>,
  error: Option<UiError>,
  hostname: String,
}

#[tauri::command]
pub fn get_state(app: AppHandle) -> UiState {
  let st = app.state::<AppState>();
  let state = UiState {
    lang: texts().lang(),
    test: st.paths.flavor.test,
    reset: *st.reset.lock().unwrap(),
    mode: st.settings.lock().unwrap().mode,
    starting: *st.starting.lock().unwrap(),
    existing: settings::existing_node(&st.paths.node_home),
    link: st.link.lock().unwrap().clone(),
    error: st.error.lock().unwrap().clone(),
    hostname: app::hostname(),
  };
  state
}

/// Runs `f` off the async runtime: choosing stops the previous process, which may take up to 15 s.
async fn blocking(app: AppHandle, f: impl FnOnce(&AppHandle) -> Result<(), String> + Send + 'static) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || f(&app)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn choose_hub(app: AppHandle) -> Result<(), String> {
  blocking(app, |a| app::choose(a, Mode::Hub)).await
}

#[tauri::command]
pub async fn pair(app: AppHandle, hub: String, code: String, name: String) -> Result<(), String> {
  blocking(app, move |a| app::pair(a, &hub, &code, &name)).await
}

#[tauri::command]
pub async fn use_existing_node(app: AppHandle) -> Result<(), String> {
  blocking(app, |a| app::choose(a, Mode::Node)).await
}

#[tauri::command]
pub fn open_log(app: AppHandle) {
  app::open_log(&app);
}

#[tauri::command]
pub async fn retry(app: AppHandle) -> Result<(), String> {
  blocking(app, |a| {
    app::restart(a);
    app::open_ui(a);
    Ok(())
  })
  .await
}

/// Deletes everything ("Reset Owlbot…", confirmed), then starts over or quits.
#[tauri::command]
pub async fn reset_app(app: AppHandle, quit: bool) -> Result<(), String> {
  blocking(app, move |a| app::reset(a, quit)).await
}

#[tauri::command]
pub fn dismiss(app: AppHandle) {
  let st = app.state::<AppState>();
  *st.link.lock().unwrap() = None;
  *st.reset.lock().unwrap() = false;
  crate::window::close_setup(&app);
}
