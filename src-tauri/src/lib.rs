use base64::Engine;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{State, Manager};

static CHILD: std::sync::OnceLock<Mutex<Option<std::process::Child>>> = std::sync::OnceLock::new();

/// Sidecar 进程状态
struct SidecarState {
    child: Mutex<Option<std::process::Child>>,
    port: Mutex<Option<u16>>,
}

#[derive(Serialize)]
struct ImageEntry {
    name: String,
    base64: String,
    width: u32,
    height: u32,
    /// 完整文件路径（sidecar 用）
    path: Option<String>,
}

/// 前端调用 SAM segment 的请求
#[derive(Deserialize, Serialize)]
struct SamPointReq {
    x: f64,
    y: f64,
    label: u8,
}

#[derive(Deserialize, Serialize)]
struct SamBoxReq {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[derive(Deserialize, Serialize)]
struct SamSegmentReq {
    image_path: String,
    image_b64: Option<String>,
    points: Option<Vec<SamPointReq>>,
    #[serde(rename = "box")]
    box_: Option<SamBoxReq>,
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
                        path: Some(file_path.to_string_lossy().to_string()),
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
        path: Some(path.to_string_lossy().to_string()),
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

/// Start Python SAM sidecar and return the port
#[tauri::command]
async fn sam_sidecar_start(state: State<'_, SidecarState>) -> Result<u16, String> {
    // 已有进程直接返回
    {
        let port = state.port.lock().map_err(|e| e.to_string())?;
        if let Some(p) = *port {
            return Ok(p);
        }
    }

    // 找 Python 路径
    // 优先读环境变量 SAM_PYTHON，否则用默认路径
    let python_exe = std::env::var("SAM_PYTHON").unwrap_or_else(|_| r"D:\79458\Documents\anaconda3\envs\deeplearning\python.exe".to_string());
    // 脚本路径：exe 同级 sidecar/
    let exe_dir = std::env::current_exe().map_err(|e| e.to_string())?.parent().ok_or("no exe dir")?.to_path_buf();
    let script = exe_dir.join("sidecar").join("sam_server.py");
    let script = script.to_string_lossy().to_string();

    if !std::path::Path::new(python_exe).exists() {
        return Err(format!("Python not found: {}", python_exe));
    }
    if !std::path::Path::new(&script).exists() {
        return Err(format!("Script not found: {}", script));
    }

    // 启动进程
    let mut child = std::process::Command::new(python_exe)
        .arg(script)
        .env("SAM_PORT", "1421")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start sidecar: {}", e))?;

    // 读 stdout 找端口（等 READY 输出）
    use std::io::{BufRead, BufReader};
    let mut stdout = child.stdout.take().ok_or("No stdout")?;
    let mut reader = BufReader::new(&mut stdout);

    // 等待 "listening on http://127.0.0.1:PORT" 或 "READY"
    let mut port: Option<u16> = None;
    let mut line = String::new();

    // 超时 30 秒（加载模型需要时间）
    let start = std::time::Instant::now();
    while start.elapsed().as_secs() < 30 {
        line.clear();
        let n = reader.read_line(&mut line).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        let trimmed = line.trim();
        println!("[sidecar] {}", trimmed);

        // 解析端口
        if let Some(idx) = trimmed.find("127.0.0.1:") {
            let rest = &trimmed[idx + "127.0.0.1:".len()..];
            if let Some(end) = rest.find(|c: char| !c.is_ascii_digit()) {
                if let Ok(p) = rest[..end].parse::<u16>() {
                    port = Some(p);
                    break;
                }
            } else if let Ok(p) = rest.parse::<u16>() {
                port = Some(p);
                break;
            }
        }
    }

    let port = port.ok_or("Sidecar did not report port within 30s")?;

    // 同时存全局，供 Exit 时杀（child 先 move 到全局，再存 state）
    {
        if let Some(g) = CHILD.get() {
            if let Ok(mut l) = g.lock() { *l = Some(child); }
        }
        let mut child_lock = state.child.lock().map_err(|e| e.to_string())?;
        // state 里存个占位（Exit 用全局杀）
        *child_lock = None;
    }
    {
        let mut port_lock = state.port.lock().map_err(|e| e.to_string())?;
        *port_lock = Some(port);
    }

    Ok(port)
}

/// Stop Python SAM sidecar
#[tauri::command]
async fn sam_sidecar_stop(state: State<'_, SidecarState>) -> Result<(), String> {
    let mut child_lock = state.child.lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = child_lock.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    let mut port_lock = state.port.lock().map_err(|e| e.to_string())?;
    *port_lock = None;
    Ok(())
}

/// Call SAM segment via sidecar HTTP API
#[tauri::command]
async fn sam_segment(
    state: State<'_, SidecarState>,
    req: SamSegmentReq,
) -> Result<serde_json::Value, String> {
    let port = {
        let port_lock = state.port.lock().map_err(|e| e.to_string())?;
        port_lock.ok_or("Sidecar not started")?
    };

    // 如果有 base64，先写到临时文件
    let mut image_path = req.image_path.clone();
    if let Some(b64) = req.image_b64 {
        use base64::Engine;
        let img_bytes = base64::engine::general_purpose::STANDARD
            .decode(&b64)
            .map_err(|e| format!("base64 decode error: {}", e))?;
        let tmp_dir = std::env::temp_dir();
        let tmp_file = tmp_dir.join(format!("sam_input_{}.jpg", uuid::Uuid::new_v4()));
        std::fs::write(&tmp_file, &img_bytes)
            .map_err(|e| format!("write temp file error: {}", e))?;
        image_path = tmp_file.to_string_lossy().to_string();
    }

    let url = format!("http://127.0.0.1:{}/segment", port);
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .json(&serde_json::json!({
            "image_path": image_path,
            "points": req.points,
            "box": req.box_,
        }))
        .send()
        .await
        .map_err(|e| format!("HTTP error: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Sidecar error {}: {}", status, body));
    }

    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(json)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(SidecarState {
            child: Mutex::new(None),
            port: Mutex::new(None),
        })
        .setup(|_app| {
            let _ = CHILD.set(Mutex::new(None));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_images_from_dir,
            read_image_file,
            write_annotation_files,
            read_file_as_string,
            pick_directory,
            pick_images,
            pick_save_directory,
            save_file_base64,
            sam_sidecar_start,
            sam_sidecar_stop,
            sam_segment,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(g) = CHILD.get() {
                    if let Ok(mut l) = g.lock() {
                        if let Some(mut child) = l.take() {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }
                }
            }
        });
}
