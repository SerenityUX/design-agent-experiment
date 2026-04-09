use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    Emitter,
};

/// Explicitly request macOS screen recording permission and, if already denied,
/// open System Settings so the user can grant it manually.
#[cfg(target_os = "macos")]
fn ensure_screen_recording_permission() {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }
    unsafe {
        if !CGPreflightScreenCaptureAccess() {
            let granted = CGRequestScreenCaptureAccess();
            if !granted {
                // Already denied — send user to System Settings
                let _ = std::process::Command::new("open")
                    .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
                    .spawn();
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn ensure_screen_recording_permission() {}

#[tauri::command]
fn request_screen_recording_permission() {
    ensure_screen_recording_permission();
}

#[tauri::command]
fn take_screenshot() -> Result<String, String> {
    use base64::{engine::general_purpose, Engine};
    use screenshots::Screen;

    ensure_screen_recording_permission();

    let screens = Screen::all().map_err(|e| e.to_string())?;
    let screen = screens.into_iter().next().ok_or("No screen found")?;
    let image = screen.capture().map_err(|e| e.to_string())?;

    let tmp = std::env::temp_dir().join("ui_ast_screenshot.png");
    image.save(tmp.to_str().unwrap()).map_err(|e| e.to_string())?;
    let png_bytes = std::fs::read(&tmp).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&tmp);

    Ok(general_purpose::STANDARD.encode(&png_bytes))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            take_screenshot,
            request_screen_recording_permission
        ])
        .setup(|app| {
            let toggle_minimal = MenuItemBuilder::new("Toggle Minimalist Mode")
                .id("toggle_minimal_ui")
                .build(app)?;

            let request_perms = MenuItemBuilder::new("Request Screen Recording Perms")
                .id("request_screen_perms")
                .build(app)?;

            let view_menu = SubmenuBuilder::new(app, "View")
                .item(&toggle_minimal)
                .separator()
                .item(&request_perms)
                .build()?;

            let menu = MenuBuilder::new(app).item(&view_menu).build()?;

            app.set_menu(menu)?;

            app.on_menu_event(|app, event| {
                match event.id().as_ref() {
                    "toggle_minimal_ui" => {
                        let _ = app.emit("toggle-minimal-ui", ());
                    }
                    "request_screen_perms" => {
                        ensure_screen_recording_permission();
                    }
                    _ => {}
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
