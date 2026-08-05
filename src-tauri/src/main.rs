// Vocap desktop shell.
//
// The game itself is the same web app that runs in a browser; this only wraps
// it in a native window so it can sit above other work, which is the whole
// point of an ambient companion. Nothing game-related lives in here.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        // Remembers where you put the window and how big you made it.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            let win = app.get_webview_window("main").unwrap();
            // Always-on-top is set in the config, but re-asserting it here
            // survives some window managers that ignore the initial flag.
            let _ = win.set_always_on_top(true);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Vocap");
}
