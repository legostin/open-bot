// Owlbot desktop app: a window for the hub's web UI, a menu bar / tray icon, and the hub (or this computer's
// machine daemon) running in the background on the bundled Node.
// Spec: docs/superpowers/specs/2026-10-26-desktop-app-design.md
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod autostart;
mod commands;
mod deeplink;
mod i18n;
mod login;
#[cfg(target_os = "macos")]
mod migration;
mod settings;
mod shellpath;
mod supervisor;
mod tray;
mod window;

fn main() {
  let args = app::Args::parse(std::env::args().skip(1));
  tauri::Builder::default()
    // First: a second launch (and a link on Windows) goes to the running app.
    .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| app::second_instance(app, argv)))
    .plugin(tauri_plugin_deep_link::init())
    .plugin(tauri_plugin_opener::init())
    .invoke_handler(tauri::generate_handler![
      commands::get_state,
      commands::choose_hub,
      commands::pair,
      commands::use_existing_node,
      commands::open_log,
      commands::retry,
      commands::dismiss
    ])
    .on_window_event(window::on_event)
    .setup(move |app| app::setup(app, args))
    .build(tauri::generate_context!())
    .expect("Owlbot failed to start")
    .run(app::on_run_event);
}
