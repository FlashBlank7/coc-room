use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use tauri_plugin_sql::{Migration, MigrationKind};
use tokio::time::{timeout_at, Instant};
use zeroize::Zeroizing;

const KEYRING_SERVICE: &str = "org.coc-room.desktop";
const KEYRING_ACCOUNT: &str = "deepseek-api-key";
const MAX_SOURCE_FILE_BYTES: u64 = 25 * 1024 * 1024;
const MODULE_PARSER_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const MAX_SIDECAR_STDOUT_BYTES: usize = 16 * 1024 * 1024;
const MAX_SIDECAR_STDERR_BYTES: usize = 64 * 1024;

#[derive(Default)]
struct AuthorizedModuleSources(Mutex<HashSet<PathBuf>>);

#[derive(Default)]
struct ModuleParserExecutionGate {
    running: AtomicBool,
}

impl ModuleParserExecutionGate {
    fn try_acquire(&self) -> Result<ModuleParserPermit<'_>, String> {
        self.running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "已有模组解析任务正在运行".to_string())?;
        Ok(ModuleParserPermit {
            running: &self.running,
        })
    }
}

struct ModuleParserPermit<'a> {
    running: &'a AtomicBool,
}

impl Drop for ModuleParserPermit<'_> {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Release);
    }
}

// Stays armed across awaits so early returns and cancelled command futures terminate the child.
struct SidecarChildGuard {
    child: Option<CommandChild>,
}

impl SidecarChildGuard {
    fn new(child: CommandChild) -> Self {
        Self { child: Some(child) }
    }

    fn write(&mut self, payload: &[u8]) -> Result<(), String> {
        let child = self
            .child
            .as_mut()
            .ok_or_else(|| "模组解析器进程不可用".to_string())?;
        child
            .write(payload)
            .map_err(|_| "无法向模组解析器写入请求".to_string())
    }

    fn disarm(&mut self) {
        drop(self.child.take());
    }

    fn kill(&mut self) {
        if let Some(child) = self.child.take() {
            let _ = child.kill();
        }
    }
}

impl Drop for SidecarChildGuard {
    fn drop(&mut self) {
        self.kill();
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ModuleParseRequest {
    id: String,
    action: String,
    source_text: Option<String>,
    source_path: Option<String>,
    source_name: String,
    model: String,
    mock: Option<bool>,
}

#[derive(Serialize)]
struct SidecarParseRequest<'a> {
    id: &'a str,
    action: &'static str,
    source_text: Option<&'a str>,
    source_path: Option<&'a str>,
    source_name: &'a str,
    model: &'a str,
    mock: bool,
    api_key: Option<&'a str>,
    cache_dir: &'a str,
}

fn keyring_entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|error| error.to_string())
}

#[tauri::command]
fn save_deepseek_key(key: String) -> Result<(), String> {
    let key = Zeroizing::new(key);
    if key.is_empty() || key.len() > 512 {
        return Err("DeepSeek API Key 长度无效".to_string());
    }
    keyring_entry()?
        .set_password(key.as_str())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn has_deepseek_key() -> bool {
    keyring_entry()
        .and_then(|entry| entry.get_password().map_err(|error| error.to_string()))
        .map(|key| !Zeroizing::new(key).is_empty())
        .unwrap_or(false)
}

#[tauri::command]
fn delete_deepseek_key() -> Result<(), String> {
    match keyring_entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
async fn select_module_source(
    app: tauri::AppHandle,
    authorized: State<'_, AuthorizedModuleSources>,
) -> Result<Option<String>, String> {
    let selected = app
        .dialog()
        .file()
        .add_filter("模组文本", &["txt", "md", "docx", "zip"])
        .blocking_pick_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|_| "文件对话框没有返回本机路径".to_string())?;
    let canonical = inspect_module_source(&path)?;
    authorized
        .0
        .lock()
        .map_err(|_| "模组文件授权状态不可用".to_string())?
        .insert(canonical.clone());
    Ok(Some(path_to_string(&canonical)?))
}

#[tauri::command]
async fn run_module_parser(
    app: tauri::AppHandle,
    authorized: State<'_, AuthorizedModuleSources>,
    execution_gate: State<'_, ModuleParserExecutionGate>,
    request: ModuleParseRequest,
) -> Result<Vec<Value>, String> {
    validate_parse_request(&request)?;
    let _permit = execution_gate.try_acquire()?;
    let deadline = Instant::now() + MODULE_PARSER_TIMEOUT;
    let mock = request.mock.unwrap_or(false);

    let source_path = if let Some(raw_path) = request.source_path.as_deref() {
        let canonical = inspect_module_source(Path::new(raw_path))?;
        let permitted = authorized
            .0
            .lock()
            .map_err(|_| "模组文件授权状态不可用".to_string())?
            .contains(&canonical);
        if !permitted {
            return Err("请通过模组编辑器的系统文件对话框重新选择该文件".to_string());
        }
        Some(canonical)
    } else {
        None
    };
    let source_path_text = source_path.as_deref().map(path_to_string).transpose()?;
    let source_name = source_path
        .as_deref()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        .unwrap_or(&request.source_name)
        .to_string();

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("无法定位应用缓存目录: {error}"))?
        .join("module-parser");
    std::fs::create_dir_all(&cache_dir)
        .map_err(|error| format!("无法创建模组解析缓存目录: {error}"))?;
    let cache_dir_text = path_to_string(&cache_dir)?;

    let api_key = if mock {
        None
    } else {
        Some(Zeroizing::new(
            keyring_entry()?
                .get_password()
                .map_err(|_| "尚未保存 DeepSeek API Key".to_string())?,
        ))
    };
    let serialized = {
        let sidecar_request = SidecarParseRequest {
            id: &request.id,
            action: "parse_module",
            source_text: request.source_text.as_deref(),
            source_path: source_path_text.as_deref(),
            source_name: &source_name,
            model: &request.model,
            mock,
            api_key: api_key.as_deref().map(String::as_str),
            cache_dir: &cache_dir_text,
        };
        Zeroizing::new(
            serde_json::to_string(&sidecar_request)
                .map_err(|error| format!("无法序列化解析请求: {error}"))?,
        )
    };

    let sidecar = app
        .shell()
        .sidecar("module-parser")
        .map_err(|error| format!("无法加载模组解析器: {error}"))?
        // Line mode buffers until a delimiter; raw mode lets our byte caps apply incrementally.
        .set_raw_out(true);
    let (mut receiver, child) = sidecar
        .spawn()
        .map_err(|error| format!("无法启动模组解析器: {error}"))?;
    let mut child = SidecarChildGuard::new(child);
    let mut stdin_payload = Zeroizing::new(Vec::with_capacity(serialized.len() + 1));
    stdin_payload.extend_from_slice(serialized.as_bytes());
    stdin_payload.push(b'\n');
    child.write(stdin_payload.as_slice())?;
    drop(stdin_payload);
    drop(serialized);
    drop(api_key);

    let mut stdout = Vec::new();
    let mut stderr_bytes = 0;
    loop {
        let event = match timeout_at(deadline, receiver.recv()).await {
            Ok(Some(event)) => event,
            Ok(None) => return Err("模组解析器通信异常".to_string()),
            Err(_) => return Err("模组解析超时，已终止解析器".to_string()),
        };
        match event {
            CommandEvent::Stdout(bytes) => {
                if !append_bytes_bounded(&mut stdout, &bytes, MAX_SIDECAR_STDOUT_BYTES) {
                    return Err("模组解析器输出超过安全上限，已终止解析器".to_string());
                }
            }
            CommandEvent::Stderr(bytes) => {
                if !add_size_bounded(&mut stderr_bytes, bytes.len(), MAX_SIDECAR_STDERR_BYTES) {
                    return Err("模组解析器错误输出超过安全上限，已终止解析器".to_string());
                }
            }
            CommandEvent::Error(_) => {
                return Err("模组解析器通信异常".to_string());
            }
            CommandEvent::Terminated(status) => {
                child.disarm();
                if status.code != Some(0) {
                    return Err(sidecar_exit_summary(stderr_bytes).to_string());
                }
                break;
            }
            _ => return Err("模组解析器返回未知事件".to_string()),
        }
    }

    let stdout =
        String::from_utf8(stdout).map_err(|_| "模组解析器返回了非 UTF-8 输出".to_string())?;
    let messages = stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            serde_json::from_str::<Value>(line)
                .map_err(|error| format!("解析器返回了非法 JSONL: {error}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    if messages.is_empty() {
        Err("模组解析器没有返回结果".to_string())
    } else {
        Ok(messages)
    }
}

fn append_bytes_bounded(buffer: &mut Vec<u8>, bytes: &[u8], limit: usize) -> bool {
    let Some(new_len) = buffer.len().checked_add(bytes.len()) else {
        return false;
    };
    if new_len > limit {
        return false;
    }
    buffer.extend_from_slice(bytes);
    true
}

fn add_size_bounded(total: &mut usize, added: usize, limit: usize) -> bool {
    let Some(new_total) = total.checked_add(added) else {
        return false;
    };
    if new_total > limit {
        return false;
    }
    *total = new_total;
    true
}

fn sidecar_exit_summary(stderr_bytes: usize) -> &'static str {
    if stderr_bytes == 0 {
        "模组解析器异常退出"
    } else {
        "模组解析器异常退出（stderr 已脱敏）"
    }
}

fn validate_parse_request(request: &ModuleParseRequest) -> Result<(), String> {
    if request.action != "parse_module" {
        return Err("不支持的模组解析操作".to_string());
    }
    if request.id.is_empty() || request.id.len() > 200 {
        return Err("解析任务 ID 长度无效".to_string());
    }
    if request.source_text.is_some() == request.source_path.is_some() {
        return Err("必须且只能提供文本或已授权文件路径之一".to_string());
    }
    if request
        .source_text
        .as_ref()
        .is_some_and(|text| text.is_empty() || text.len() > 5_000_000)
    {
        return Err("模组文本为空或超过 500 万字符".to_string());
    }
    if request.source_name.is_empty()
        || request.source_name.len() > 260
        || request.source_name.chars().any(char::is_control)
    {
        return Err("模组来源名称无效".to_string());
    }
    if request.model.is_empty()
        || request.model.len() > 100
        || !request
            .model
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".-_".contains(character))
    {
        return Err("DeepSeek 模型名称无效".to_string());
    }
    Ok(())
}

fn inspect_module_source(path: &Path) -> Result<PathBuf, String> {
    let canonical = path
        .canonicalize()
        .map_err(|_| "所选模组文件不存在或不可访问".to_string())?;
    let metadata = canonical
        .metadata()
        .map_err(|_| "无法读取所选模组文件信息".to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_SOURCE_FILE_BYTES {
        return Err("模组来源必须是 25 MiB 以内的普通文件".to_string());
    }
    let extension = canonical
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "模组文件缺少受支持的扩展名".to_string())?;
    if !matches!(extension.as_str(), "txt" | "md" | "docx" | "zip") {
        return Err("只支持 TXT、Markdown、DOCX 或单文档 ZIP".to_string());
    }
    Ok(canonical)
}

fn path_to_string(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| "当前版本不支持非 Unicode 文件路径".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![Migration {
        version: 1,
        description: "initial local-first schema",
        sql: include_str!("../migrations/0001_initial.sql"),
        kind: MigrationKind::Up,
    }];

    tauri::Builder::default()
        .manage(AuthorizedModuleSources::default())
        .manage(ModuleParserExecutionGate::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:coc-room.db", migrations)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            save_deepseek_key,
            has_deepseek_key,
            delete_deepseek_key,
            select_module_source,
            run_module_parser
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.get_webview_window("main")
                    .expect("main window")
                    .open_devtools();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running coc-room");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parser_execution_gate_allows_only_one_permit() {
        let gate = ModuleParserExecutionGate::default();
        let permit = gate.try_acquire().expect("first permit should succeed");

        assert!(gate.try_acquire().is_err());

        drop(permit);
        assert!(gate.try_acquire().is_ok());
    }

    #[test]
    fn bounded_byte_append_is_atomic_at_limit() {
        let mut buffer = Vec::new();

        assert!(append_bytes_bounded(&mut buffer, b"abc", 3));
        assert_eq!(buffer, b"abc");
        assert!(!append_bytes_bounded(&mut buffer, b"x", 3));
        assert_eq!(buffer, b"abc");
    }

    #[test]
    fn bounded_stderr_counter_rejects_overflow_without_mutation() {
        let mut total = 0;

        assert!(add_size_bounded(&mut total, 3, 3));
        assert_eq!(total, 3);
        assert!(!add_size_bounded(&mut total, 1, 3));
        assert_eq!(total, 3);
    }

    #[test]
    fn stderr_summary_never_returns_raw_stderr() {
        let secret = "sk-do-not-return-this";
        let summary = sidecar_exit_summary(secret.len());

        assert_eq!(summary, "模组解析器异常退出（stderr 已脱敏）");
        assert!(!summary.contains(secret));
    }
}
