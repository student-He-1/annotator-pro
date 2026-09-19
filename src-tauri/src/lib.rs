use base64::Engine;
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use tauri::State;

struct AppState {
    // Could store persistent state here
}

#[derive(Serialize)]
struct ImageEntry {
    name: String,
    base64: String,
    width: u32,
    height: u32,
}

/// Read all images from a directory, return as base64 encoded data
fn is_image_extension(ext: &str) -> bool {
    matches!(ext, "jpg" | "jpeg" | "png" | "bmp" | "webp" | "gif" | "svg" | "ico" | "tiff" | "tif" | "avif")
}

fn get_mime_type(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "bmp" => "image/bmp",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "tiff" | "tif" => "image/tiff",
        "avif" => "image/avif",
        _ => "image/png",
    }
}

#[tauri::command]
fn read_images_from_dir(dir_path: String) -> Result<Vec<ImageEntry>, String> {
    let path = PathBuf::from(&dir_path);
    if !path.is_dir() {
        return Err("Not a valid directory".to_string());
    }

    let mut images = Vec::new();

    // 递归读取目录
    fn read_dir_recursive(dir: &PathBuf, images: &mut Vec<ImageEntry>) -> Result<(), String> {
        let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let file_path = entry.path();

            if file_path.is_dir() {
                read_dir_recursive(&file_path, images)?;
            } else if let Some(ext) = file_path.extension() {
                let ext_lower = ext.to_string_lossy().to_lowercase();
                if is_image_extension(&ext_lower) {
                    let file_bytes = fs::read(&file_path).map_err(|e| e.to_string())?;
                    let mime = get_mime_type(&ext_lower);
                    let base64_str = format!(
                        "data:{};base64,{}",
                        mime,
                        base64::engine::general_purpose::STANDARD.encode(&file_bytes)
                    );

                    // 使用相对路径作为名称，保持层级结构
                    let rel_name = file_path.strip_prefix(dir.parent().unwrap_or(dir))
                        .unwrap_or(&file_path)
                        .to_string_lossy()
                        .to_string();

                    images.push(ImageEntry {
                        name: rel_name,
                        base64: base64_str,
                        width: 0,
                        height: 0,
                    });
                }
            }
        }
        Ok(())
    }

    read_dir_recursive(&path, &mut images)?;
    images.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(images)
}

/// Write annotation files to a directory
#[tauri::command]
fn write_annotation_files(dir_path: String, files: Vec<(String, String)>) -> Result<u32, String> {
    let path = PathBuf::from(&dir_path);
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;

    let mut count = 0u32;
    for (filename, content) in files {
        let file_path = path.join(&filename);
        fs::write(&file_path, content).map_err(|e| e.to_string())?;
        count += 1;
    }

    Ok(count)
}

/// Read a single image file as base64
#[tauri::command]
fn read_image_file(file_path: String) -> Result<ImageEntry, String> {
    let path = PathBuf::from(&file_path);
    if !path.is_file() {
        return Err("File not found".to_string());
    }

    let ext = path.extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();

    let valid_exts = ["jpg", "jpeg", "png", "bmp", "webp", "gif"];
    if !valid_exts.contains(&ext.as_str()) {
        return Err("Not a valid image file".to_string());
    }

    let file_bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "bmp" => "image/bmp",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "image/png",
    };
    let base64_str = format!(
        "data:{};base64,{}",
        mime,
        base64::engine::general_purpose::STANDARD.encode(&file_bytes)
    );

    Ok(ImageEntry {
        name: path.file_name().unwrap().to_string_lossy().to_string(),
        base64: base64_str,
        width: 0,
        height: 0,
    })
}

/// Read a single file as bytes (for importing annotation files)
#[tauri::command]
fn read_file_as_string(file_path: String) -> Result<String, String> {
    fs::read_to_string(&file_path).map_err(|e| e.to_string())
}

/// Select a directory using native dialog
#[tauri::command]
async fn pick_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let result = app
        .dialog()
        .file()
        .blocking_pick_folder();
    Ok(result.map(|p| p.to_string()))
}

/// Select image files using native dialog
#[tauri::command]
async fn pick_images(app: tauri::AppHandle) -> Result<Option<Vec<String>>, String> {
    use tauri_plugin_dialog::DialogExt;
    let result = app
        .dialog()
        .file()
        .add_filter("Images", &["jpg", "jpeg", "png", "bmp", "webp", "gif"])
        .blocking_pick_files();
    Ok(result.map(|paths| paths.iter().map(|p| p.to_string()).collect()))
}

/// Select a save directory using native dialog
#[tauri::command]
async fn pick_save_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let result = app
        .dialog()
        .file()
        .blocking_pick_folder();
    Ok(result.map(|p| p.to_string()))
}

/// Save a base64 encoded file to the specified directory
#[tauri::command]
fn save_file_base64(dir_path: String, filename: String, content_base64: String) -> Result<String, String> {
    let path = PathBuf::from(&dir_path);
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    let file_path = path.join(&filename);
    let bytes = base64::engine::general_purpose::STANDARD.decode(&content_base64)
        .map_err(|e| e.to_string())?;
    fs::write(&file_path, bytes).map_err(|e| e.to_string())?;
    Ok(file_path.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AppState {})
        .invoke_handler(tauri::generate_handler![
            read_images_from_dir,
            read_image_file,
            write_annotation_files,
            read_file_as_string,
            pick_directory,
            pick_images,
            pick_save_directory,
            save_file_base64,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
