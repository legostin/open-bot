// App commands are allowed only where a capability grants them: capabilities/setup.json gives them to the setup
// window; the hub's page in the main window gets none.
fn main() {
  tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
    "get_state",
    "choose_hub",
    "pair",
    "use_existing_node",
    "open_log",
    "retry",
    "dismiss",
    "reset_app",
  ])))
  .expect("tauri-build failed");
}
