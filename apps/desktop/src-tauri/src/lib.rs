use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager, State};
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
const MAX_NETWORK_SMOKE_REPORT_BYTES: usize = 64 * 1024;
const MAX_NETWORK_SMOKE_RENDEZVOUS_BYTES: usize = 8 * 1024;
const MAX_STORAGE_SMOKE_EXPORT_BYTES: usize = 2 * 1024 * 1024;
const STORAGE_SMOKE_MARKDOWN_FILE: &str = "transcript.md";
const STORAGE_SMOKE_HTML_FILE: &str = "transcript.html";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NetworkSmokeConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    relay_url: Option<String>,
    mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    process_role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NetworkSmokeRendezvous {
    protocol_version: u8,
    run_id: String,
    mode: String,
    room_id: String,
    host_peer_id: String,
    join_token: String,
    websocket_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageSmokeExportResult {
    markdown_file: &'static str,
    html_file: &'static str,
    markdown_bytes: usize,
    html_bytes: usize,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NetworkSmokeReport {
    ok: bool,
    mode: String,
    message: String,
    details: Option<Value>,
}

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
fn network_smoke_config() -> Result<Option<NetworkSmokeConfig>, String> {
    parse_network_smoke_config(
        std::env::var("COC_ROOM_NETWORK_SMOKE").ok().as_deref(),
        std::env::var("COC_ROOM_NETWORK_SMOKE_URL").ok().as_deref(),
        std::env::var("COC_ROOM_NETWORK_SMOKE_MODE").ok().as_deref(),
        std::env::var("COC_ROOM_NETWORK_SMOKE_ROLE").ok().as_deref(),
        std::env::var("COC_ROOM_NETWORK_SMOKE_COORDINATION")
            .ok()
            .as_deref(),
        std::env::var("COC_ROOM_NETWORK_SMOKE_RUN_ID")
            .ok()
            .as_deref(),
    )
}

fn parse_network_smoke_config(
    enabled: Option<&str>,
    relay_url: Option<&str>,
    mode: Option<&str>,
    process_role: Option<&str>,
    coordination_path: Option<&str>,
    run_id: Option<&str>,
) -> Result<Option<NetworkSmokeConfig>, String> {
    if enabled != Some("1") {
        return Ok(None);
    }
    let mode = mode
        .ok_or_else(|| "COC_ROOM_NETWORK_SMOKE_MODE is required".to_string())?
        .to_string();
    if !matches!(mode.as_str(), "direct" | "relay" | "storage") {
        return Err("network smoke mode must be direct, relay, or storage".to_string());
    }
    let relay_url = if mode == "storage" {
        None
    } else {
        let relay_url = relay_url
            .ok_or_else(|| "COC_ROOM_NETWORK_SMOKE_URL is required".to_string())?
            .to_string();
        if !(relay_url.starts_with("http://127.0.0.1:")
            || relay_url.starts_with("http://localhost:")
            || relay_url.starts_with("https://"))
        {
            return Err(
                "network smoke relay URL must use HTTPS or a loopback HTTP origin".to_string(),
            );
        }
        Some(relay_url)
    };
    let has_process_coordination =
        process_role.is_some() || coordination_path.is_some() || run_id.is_some();
    let process_role = if has_process_coordination {
        if !matches!(mode.as_str(), "direct" | "relay") {
            return Err(
                "multi-process smoke is available only for direct or relay mode".to_string(),
            );
        }
        let role = process_role
            .filter(|role| matches!(*role, "host" | "player"))
            .ok_or_else(|| "multi-process smoke role must be host or player".to_string())?;
        let path = coordination_path
            .map(Path::new)
            .ok_or_else(|| "multi-process smoke coordination path is required".to_string())?;
        validate_absolute_file_parent(path, "multi-process smoke coordination")?;
        let run_id = run_id
            .filter(|candidate| is_smoke_identifier(candidate))
            .ok_or_else(|| "multi-process smoke run ID is invalid".to_string())?;
        Some((role.to_string(), run_id.to_string()))
    } else {
        None
    };
    Ok(Some(NetworkSmokeConfig {
        relay_url,
        mode,
        process_role: process_role.as_ref().map(|(role, _)| role.clone()),
        run_id: process_role.map(|(_, run_id)| run_id),
    }))
}

fn is_smoke_identifier(value: &str) -> bool {
    (16..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn validate_absolute_file_parent(path: &Path, label: &str) -> Result<PathBuf, String> {
    if !path.is_absolute() || path.file_name().is_none() {
        return Err(format!("{label} path must be an absolute file path"));
    }
    let parent = path
        .parent()
        .ok_or_else(|| format!("{label} path has no parent"))?
        .canonicalize()
        .map_err(|_| format!("{label} directory does not exist"))?;
    Ok(parent.join(
        path.file_name()
            .ok_or_else(|| format!("{label} path has no file name"))?,
    ))
}

fn network_smoke_process_context(expected_role: &str) -> Result<(String, String, PathBuf), String> {
    let config = parse_network_smoke_config(
        std::env::var("COC_ROOM_NETWORK_SMOKE").ok().as_deref(),
        std::env::var("COC_ROOM_NETWORK_SMOKE_URL").ok().as_deref(),
        std::env::var("COC_ROOM_NETWORK_SMOKE_MODE").ok().as_deref(),
        std::env::var("COC_ROOM_NETWORK_SMOKE_ROLE").ok().as_deref(),
        std::env::var("COC_ROOM_NETWORK_SMOKE_COORDINATION")
            .ok()
            .as_deref(),
        std::env::var("COC_ROOM_NETWORK_SMOKE_RUN_ID")
            .ok()
            .as_deref(),
    )?
    .ok_or_else(|| "network smoke mode is not enabled".to_string())?;
    if config.process_role.as_deref() != Some(expected_role) {
        return Err(format!(
            "network smoke rendezvous command requires the {expected_role} role"
        ));
    }
    let run_id = config
        .run_id
        .ok_or_else(|| "multi-process smoke run ID is missing".to_string())?;
    let target = validate_absolute_file_parent(
        Path::new(
            &std::env::var("COC_ROOM_NETWORK_SMOKE_COORDINATION")
                .map_err(|_| "multi-process smoke coordination path is required".to_string())?,
        ),
        "multi-process smoke coordination",
    )?;
    Ok((config.mode, run_id, target))
}

fn validate_network_smoke_rendezvous(
    rendezvous: &NetworkSmokeRendezvous,
    expected_mode: &str,
    expected_run_id: &str,
) -> Result<(), String> {
    if rendezvous.protocol_version != 1
        || rendezvous.mode != expected_mode
        || rendezvous.run_id != expected_run_id
    {
        return Err("network smoke rendezvous does not match this run".to_string());
    }
    if !is_smoke_identifier(&rendezvous.room_id)
        || !(8..=64).contains(&rendezvous.host_peer_id.len())
        || !rendezvous
            .host_peer_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err("network smoke rendezvous room identity is invalid".to_string());
    }
    if !(20..=128).contains(&rendezvous.join_token.len())
        || !rendezvous
            .join_token
            .bytes()
            .all(|byte| byte.is_ascii_graphic())
    {
        return Err("network smoke rendezvous join token is invalid".to_string());
    }
    let websocket_url = rendezvous.websocket_url.as_str();
    if websocket_url.len() > 2_048
        || !(websocket_url.starts_with("ws://127.0.0.1:")
            || websocket_url.starts_with("ws://localhost:")
            || websocket_url.starts_with("wss://"))
    {
        return Err(
            "network smoke rendezvous WebSocket URL must use WSS or loopback WS".to_string(),
        );
    }
    Ok(())
}

fn persist_network_smoke_rendezvous(
    target: &Path,
    rendezvous: &NetworkSmokeRendezvous,
    expected_mode: &str,
    expected_run_id: &str,
) -> Result<(), String> {
    validate_network_smoke_rendezvous(rendezvous, expected_mode, expected_run_id)?;
    let serialized = serde_json::to_vec(rendezvous)
        .map_err(|_| "network smoke rendezvous could not be serialized".to_string())?;
    if serialized.len() > MAX_NETWORK_SMOKE_RENDEZVOUS_BYTES {
        return Err("network smoke rendezvous exceeds the size limit".to_string());
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|error| format!("cannot create network smoke rendezvous: {error}"))?;
    file.write_all(&serialized)
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("cannot persist network smoke rendezvous: {error}"))
}

fn load_network_smoke_rendezvous(
    target: &Path,
    expected_mode: &str,
    expected_run_id: &str,
) -> Result<Option<NetworkSmokeRendezvous>, String> {
    let file = match File::open(target) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("cannot read network smoke rendezvous: {error}")),
    };
    let mut serialized = Vec::new();
    std::io::Read::take(file, (MAX_NETWORK_SMOKE_RENDEZVOUS_BYTES + 1) as u64)
        .read_to_end(&mut serialized)
        .map_err(|error| format!("cannot read network smoke rendezvous: {error}"))?;
    if serialized.len() > MAX_NETWORK_SMOKE_RENDEZVOUS_BYTES {
        return Err("network smoke rendezvous exceeds the size limit".to_string());
    }
    let rendezvous: NetworkSmokeRendezvous = serde_json::from_slice(&serialized)
        .map_err(|_| "network smoke rendezvous is invalid JSON".to_string())?;
    validate_network_smoke_rendezvous(&rendezvous, expected_mode, expected_run_id)?;
    Ok(Some(rendezvous))
}

#[tauri::command]
fn publish_network_smoke_rendezvous(rendezvous: NetworkSmokeRendezvous) -> Result<(), String> {
    let (mode, run_id, target) = network_smoke_process_context("host")?;
    persist_network_smoke_rendezvous(&target, &rendezvous, &mode, &run_id)
}

#[tauri::command]
fn read_network_smoke_rendezvous() -> Result<Option<NetworkSmokeRendezvous>, String> {
    let (mode, run_id, target) = network_smoke_process_context("player")?;
    load_network_smoke_rendezvous(&target, &mode, &run_id)
}

#[tauri::command]
fn finish_network_smoke(app: tauri::AppHandle, report: NetworkSmokeReport) -> Result<(), String> {
    if std::env::var("COC_ROOM_NETWORK_SMOKE").ok().as_deref() != Some("1") {
        return Err("network smoke mode is not enabled".to_string());
    }
    if !matches!(report.mode.as_str(), "direct" | "relay" | "storage")
        || report.message.len() > 4_000
    {
        return Err("network smoke report is invalid".to_string());
    }
    let target = PathBuf::from(
        std::env::var("COC_ROOM_NETWORK_SMOKE_RESULT")
            .map_err(|_| "COC_ROOM_NETWORK_SMOKE_RESULT is required".to_string())?,
    );
    if !target.is_absolute() || target.file_name().is_none() {
        return Err("network smoke result path must be an absolute file path".to_string());
    }
    let parent = target
        .parent()
        .ok_or_else(|| "network smoke result path has no parent".to_string())?
        .canonicalize()
        .map_err(|_| "network smoke result directory does not exist".to_string())?;
    let target = parent.join(
        target
            .file_name()
            .ok_or_else(|| "network smoke result path has no file name".to_string())?,
    );
    let serialized = serde_json::to_vec(&report)
        .map_err(|_| "network smoke report could not be serialized".to_string())?;
    if serialized.len() > MAX_NETWORK_SMOKE_REPORT_BYTES {
        return Err("network smoke report exceeds the size limit".to_string());
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|error| format!("cannot create network smoke result: {error}"))?;
    file.write_all(&serialized)
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("cannot persist network smoke result: {error}"))?;
    app.exit(if report.ok { 0 } else { 1 });
    Ok(())
}

#[tauri::command]
fn write_storage_smoke_exports(
    markdown: String,
    html: String,
) -> Result<StorageSmokeExportResult, String> {
    let configured_directory =
        std::env::var_os("COC_ROOM_NETWORK_SMOKE_EXPORT_DIR").map(PathBuf::from);
    let directory = validate_storage_smoke_export_directory(
        std::env::var("COC_ROOM_NETWORK_SMOKE").ok().as_deref(),
        std::env::var("COC_ROOM_NETWORK_SMOKE_MODE").ok().as_deref(),
        configured_directory.as_deref(),
    )?;
    persist_storage_smoke_exports(&directory, &markdown, &html)
}

fn validate_storage_smoke_export_directory(
    enabled: Option<&str>,
    mode: Option<&str>,
    directory: Option<&Path>,
) -> Result<PathBuf, String> {
    if enabled != Some("1") || mode != Some("storage") {
        return Err("storage smoke export is not enabled".to_string());
    }
    let directory =
        directory.ok_or_else(|| "COC_ROOM_NETWORK_SMOKE_EXPORT_DIR is required".to_string())?;
    if !directory.is_absolute() {
        return Err("storage smoke export directory must be absolute".to_string());
    }
    let canonical = directory
        .canonicalize()
        .map_err(|_| "storage smoke export directory does not exist".to_string())?;
    if !canonical.is_dir() {
        return Err("storage smoke export target must be a directory".to_string());
    }
    Ok(canonical)
}

fn persist_storage_smoke_exports(
    directory: &Path,
    markdown: &str,
    html: &str,
) -> Result<StorageSmokeExportResult, String> {
    let markdown_bytes =
        write_new_storage_smoke_file(directory, STORAGE_SMOKE_MARKDOWN_FILE, markdown.as_bytes())?;
    let html_bytes =
        write_new_storage_smoke_file(directory, STORAGE_SMOKE_HTML_FILE, html.as_bytes())?;
    Ok(StorageSmokeExportResult {
        markdown_file: STORAGE_SMOKE_MARKDOWN_FILE,
        html_file: STORAGE_SMOKE_HTML_FILE,
        markdown_bytes,
        html_bytes,
    })
}

fn write_new_storage_smoke_file(
    directory: &Path,
    file_name: &'static str,
    content: &[u8],
) -> Result<usize, String> {
    if content.is_empty() || content.len() > MAX_STORAGE_SMOKE_EXPORT_BYTES {
        return Err(format!(
            "storage smoke {file_name} is empty or exceeds the size limit"
        ));
    }
    let target = directory.join(file_name);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|error| format!("cannot create storage smoke {file_name}: {error}"))?;
    file.write_all(content)
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("cannot persist storage smoke {file_name}: {error}"))?;
    Ok(content.len())
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
    let mut stdout_cursor = 0;
    let mut messages = Vec::new();
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
                for message in parse_jsonl_messages(&stdout, &mut stdout_cursor, false)? {
                    validate_sidecar_request_id(&message, &request.id)?;
                    if message.get("type").and_then(Value::as_str) == Some("progress") {
                        app.emit("module-parser-progress", message.clone())
                            .map_err(|_| "无法向模组编辑器发送解析进度".to_string())?;
                    }
                    messages.push(message);
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

    for message in parse_jsonl_messages(&stdout, &mut stdout_cursor, true)? {
        validate_sidecar_request_id(&message, &request.id)?;
        if message.get("type").and_then(Value::as_str) == Some("progress") {
            app.emit("module-parser-progress", message.clone())
                .map_err(|_| "无法向模组编辑器发送解析进度".to_string())?;
        }
        messages.push(message);
    }
    if messages.is_empty() {
        Err("模组解析器没有返回结果".to_string())
    } else {
        Ok(messages)
    }
}

fn parse_jsonl_messages(
    bytes: &[u8],
    cursor: &mut usize,
    include_unterminated: bool,
) -> Result<Vec<Value>, String> {
    let mut messages = Vec::new();
    while *cursor < bytes.len() {
        let remaining = &bytes[*cursor..];
        let newline = remaining.iter().position(|byte| *byte == b'\n');
        let Some(line_len) = newline.or_else(|| include_unterminated.then_some(remaining.len()))
        else {
            break;
        };
        let line_end = *cursor + line_len;
        let next_cursor = if newline.is_some() {
            line_end + 1
        } else {
            line_end
        };
        let line = std::str::from_utf8(&bytes[*cursor..line_end])
            .map_err(|_| "模组解析器返回了非 UTF-8 输出".to_string())?
            .trim_end_matches('\r')
            .trim();
        *cursor = next_cursor;
        if line.is_empty() {
            continue;
        }
        messages.push(
            serde_json::from_str::<Value>(line)
                .map_err(|error| format!("解析器返回了非法 JSONL: {error}"))?,
        );
    }
    Ok(messages)
}

fn validate_sidecar_request_id(message: &Value, request_id: &str) -> Result<(), String> {
    if message.get("request_id").and_then(Value::as_str) != Some(request_id) {
        return Err("模组解析器返回了不匹配的任务 ID".to_string());
    }
    Ok(())
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
    let migrations = vec![
        Migration {
            version: 1,
            description: "initial local-first schema",
            sql: include_str!("../migrations/0001_initial.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "preserve every module revision",
            sql: include_str!("../migrations/0002_module_revision_history.sql"),
            kind: MigrationKind::Up,
        },
    ];

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
            network_smoke_config,
            publish_network_smoke_rendezvous,
            read_network_smoke_rendezvous,
            finish_network_smoke,
            write_storage_smoke_exports,
            select_module_source,
            run_module_parser
        ])
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                app.get_webview_window("main")
                    .expect("main window")
                    .open_devtools();
            }
            #[cfg(not(debug_assertions))]
            let _ = app;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running coc-room");
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{Connection, Row, SqliteConnection};
    use std::time::{SystemTime, UNIX_EPOCH};

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

    #[test]
    fn jsonl_messages_are_emitted_only_after_a_complete_line() {
        let mut cursor = 0;
        let partial = br#"{"request_id":"task-1","type":"progress"}"#;

        assert!(parse_jsonl_messages(partial, &mut cursor, false)
            .expect("partial JSONL should wait")
            .is_empty());
        assert_eq!(cursor, 0);

        let mut complete = partial.to_vec();
        complete.extend_from_slice(b"\n");
        let messages = parse_jsonl_messages(&complete, &mut cursor, false)
            .expect("complete JSONL should parse");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["type"], "progress");
        assert_eq!(cursor, complete.len());
    }

    #[test]
    fn sidecar_messages_must_match_the_active_request() {
        let message = serde_json::json!({ "request_id": "other", "type": "progress" });

        assert!(validate_sidecar_request_id(&message, "active").is_err());
        assert!(validate_sidecar_request_id(&message, "other").is_ok());
    }

    #[test]
    fn network_smoke_configuration_is_explicit_and_restricts_plain_http() {
        assert!(
            parse_network_smoke_config(None, None, None, None, None, None)
                .expect("disabled smoke mode should be valid")
                .is_none()
        );
        assert!(parse_network_smoke_config(
            Some("1"),
            Some("http://relay.example.test"),
            Some("direct"),
            None,
            None,
            None,
        )
        .is_err());

        let config = parse_network_smoke_config(
            Some("1"),
            Some("http://127.0.0.1:8787"),
            Some("relay"),
            None,
            None,
            None,
        )
        .expect("loopback relay smoke should be accepted")
        .expect("enabled smoke should return a configuration");
        assert_eq!(config.relay_url.as_deref(), Some("http://127.0.0.1:8787"));
        assert_eq!(config.mode, "relay");

        let storage =
            parse_network_smoke_config(Some("1"), None, Some("storage"), None, None, None)
                .expect("storage smoke should not require a relay URL")
                .expect("storage smoke should return a configuration");
        assert!(storage.relay_url.is_none());
        assert_eq!(storage.mode, "storage");
    }

    #[test]
    fn multi_process_network_smoke_requires_complete_isolated_coordination() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "coc-room-process-smoke-config-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir(&directory).expect("unique smoke directory should be created");
        let coordination = directory.join("rendezvous.json");
        let coordination_text = coordination.to_string_lossy();

        assert!(parse_network_smoke_config(
            Some("1"),
            Some("http://127.0.0.1:8787"),
            Some("direct"),
            Some("host"),
            None,
            Some("run_1234567890abcdef"),
        )
        .is_err());
        let config = parse_network_smoke_config(
            Some("1"),
            Some("http://127.0.0.1:8787"),
            Some("direct"),
            Some("host"),
            Some(&coordination_text),
            Some("run_1234567890abcdef"),
        )
        .expect("complete multi-process configuration should be accepted")
        .expect("enabled smoke should return a configuration");
        assert_eq!(config.process_role.as_deref(), Some("host"));
        assert_eq!(config.run_id.as_deref(), Some("run_1234567890abcdef"));
        assert!(parse_network_smoke_config(
            Some("1"),
            None,
            Some("storage"),
            Some("player"),
            Some(&coordination_text),
            Some("run_1234567890abcdef"),
        )
        .is_err());

        std::fs::remove_dir(&directory).expect("test directory should be removed");
    }

    #[test]
    fn network_smoke_rendezvous_is_run_bound_size_limited_and_never_overwritten() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "coc-room-process-smoke-rendezvous-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir(&directory).expect("unique smoke directory should be created");
        let target = directory.join("rendezvous.json");
        let run_id = "run_1234567890abcdef";
        let rendezvous = NetworkSmokeRendezvous {
            protocol_version: 1,
            run_id: run_id.to_string(),
            mode: "relay".to_string(),
            room_id: "room_1234567890abcdef".to_string(),
            host_peer_id: "smoke-host-1234567890abcdef".to_string(),
            join_token: "smoke-host-1234567890abcdef.secret_token_1234567890".to_string(),
            websocket_url: "ws://127.0.0.1:8787/v1/rooms/test/ws".to_string(),
        };

        persist_network_smoke_rendezvous(&target, &rendezvous, "relay", run_id)
            .expect("first rendezvous publish should create the file");
        assert!(persist_network_smoke_rendezvous(&target, &rendezvous, "relay", run_id).is_err());
        let loaded = load_network_smoke_rendezvous(&target, "relay", run_id)
            .expect("matching rendezvous should be readable")
            .expect("published rendezvous should exist");
        assert_eq!(loaded.run_id, run_id);
        assert_eq!(loaded.join_token, rendezvous.join_token);
        assert!(load_network_smoke_rendezvous(&target, "relay", "other_1234567890abcd").is_err());

        std::fs::remove_file(&target).expect("test rendezvous should be removed");
        std::fs::remove_dir(&directory).expect("test directory should be removed");
    }

    #[test]
    fn storage_smoke_exports_require_explicit_mode_and_never_overwrite() {
        assert!(validate_storage_smoke_export_directory(None, None, None).is_err());
        assert!(validate_storage_smoke_export_directory(
            Some("1"),
            Some("storage"),
            Some(Path::new("relative-directory")),
        )
        .is_err());

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "coc-room-storage-smoke-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir(&directory).expect("unique smoke directory should be created");
        let canonical =
            validate_storage_smoke_export_directory(Some("1"), Some("storage"), Some(&directory))
                .expect("explicit absolute smoke directory should be accepted");

        let result = persist_storage_smoke_exports(&canonical, "# transcript\n", "<!doctype html>")
            .expect("first export should create both files");
        assert_eq!(result.markdown_bytes, 13);
        assert_eq!(result.html_bytes, 15);
        assert_eq!(
            std::fs::read_to_string(canonical.join(STORAGE_SMOKE_MARKDOWN_FILE))
                .expect("markdown should be readable"),
            "# transcript\n"
        );
        assert_eq!(
            std::fs::read_to_string(canonical.join(STORAGE_SMOKE_HTML_FILE))
                .expect("HTML should be readable"),
            "<!doctype html>"
        );
        assert!(persist_storage_smoke_exports(&canonical, "replacement", "replacement").is_err());
        assert!(write_new_storage_smoke_file(
            &canonical,
            "oversized.txt",
            &vec![b'x'; MAX_STORAGE_SMOKE_EXPORT_BYTES + 1],
        )
        .is_err());

        std::fs::remove_file(canonical.join(STORAGE_SMOKE_MARKDOWN_FILE))
            .expect("test markdown should be removed");
        std::fs::remove_file(canonical.join(STORAGE_SMOKE_HTML_FILE))
            .expect("test HTML should be removed");
        std::fs::remove_dir(&canonical).expect("empty test directory should be removed");
    }

    #[test]
    fn deleting_a_sqlite_room_cascades_its_events() {
        tauri::async_runtime::block_on(async {
            let mut connection = SqliteConnection::connect("sqlite::memory:")
                .await
                .expect("in-memory SQLite should open");
            sqlx::raw_sql(include_str!("../migrations/0001_initial.sql"))
                .execute(&mut connection)
                .await
                .expect("initial schema should apply");
            sqlx::raw_sql(include_str!(
                "../migrations/0002_module_revision_history.sql"
            ))
            .execute(&mut connection)
            .await
            .expect("current schema should apply");
            sqlx::query(
                "INSERT INTO rooms (id, name, local_role, local_peer_id, host_peer_id, invite_token, join_token, relay_url, last_seq, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind("storage-smoke-room")
            .bind("Storage smoke")
            .bind("host")
            .bind("storage-smoke-host")
            .bind("storage-smoke-host")
            .bind("throwaway-token")
            .bind(Option::<String>::None)
            .bind("wss://storage-smoke.invalid")
            .bind(1_i64)
            .bind("2026-01-01T00:00:00.000Z")
            .bind("2026-01-01T00:00:00.000Z")
            .execute(&mut connection)
            .await
            .expect("smoke room should insert");
            sqlx::query(
                "INSERT INTO room_events (room_id, event_id, seq, event_type, sender_id, created_at, event_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind("storage-smoke-room")
            .bind("throwaway-event")
            .bind(1_i64)
            .bind("chat.message")
            .bind("storage-smoke-host")
            .bind("2026-01-01T00:00:00.000Z")
            .bind("{}")
            .execute(&mut connection)
            .await
            .expect("smoke event should insert");

            sqlx::query("DELETE FROM rooms WHERE id=?")
                .bind("storage-smoke-room")
                .execute(&mut connection)
                .await
                .expect("room deletion should succeed");

            let room_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM rooms WHERE id=?")
                .bind("storage-smoke-room")
                .fetch_one(&mut connection)
                .await
                .expect("room count should be readable");
            let event_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM room_events WHERE room_id=?")
                    .bind("storage-smoke-room")
                    .fetch_one(&mut connection)
                    .await
                    .expect("event count should be readable");
            assert_eq!(room_count, 0);
            assert_eq!(event_count, 0);
        });
    }

    #[test]
    fn module_revision_migration_preserves_legacy_data_and_accepts_history() {
        tauri::async_runtime::block_on(async {
            let mut connection = SqliteConnection::connect("sqlite::memory:")
                .await
                .expect("in-memory SQLite should open");
            sqlx::raw_sql(include_str!("../migrations/0001_initial.sql"))
                .execute(&mut connection)
                .await
                .expect("legacy schema should apply");

            let legacy_json = serde_json::json!({
                "schemaVersion": 1,
                "moduleId": "legacy-module",
                "revision": 4,
                "metadata": {
                    "title": "Legacy",
                    "authors": [],
                    "language": "zh-CN",
                    "summary": "",
                    "createdAt": "2026-01-01T00:00:00.000Z",
                    "updatedAt": "2026-01-04T00:00:00.000Z"
                },
                "overview": "",
                "sourceDocuments": [],
                "chapters": [],
                "scenes": [],
                "locations": [],
                "npcs": [],
                "clues": [],
                "handouts": [],
                "suggestedChecks": [],
                "keeperNotes": [],
                "relations": [],
                "extensions": {}
            })
            .to_string();
            sqlx::query(
                "INSERT INTO modules (id, title, schema_version, source_text, module_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind("legacy-module")
            .bind("Legacy")
            .bind(1_i64)
            .bind("legacy source")
            .bind(&legacy_json)
            .bind("2026-01-01T00:00:00.000Z")
            .bind("2026-01-04T00:00:00.000Z")
            .execute(&mut connection)
            .await
            .expect("legacy module should insert");
            sqlx::query(
                "INSERT INTO modules (id, title, schema_version, source_text, module_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind("corrupt-module")
            .bind("Corrupt but preserved")
            .bind(1_i64)
            .bind("recover me")
            .bind("not valid JSON")
            .bind("2026-01-01T00:00:00.000Z")
            .bind("2026-01-02T00:00:00.000Z")
            .execute(&mut connection)
            .await
            .expect("legacy SQLite could contain externally modified data");

            sqlx::raw_sql(include_str!(
                "../migrations/0002_module_revision_history.sql"
            ))
            .execute(&mut connection)
            .await
            .expect("revision migration should apply");

            let row =
                sqlx::query("SELECT revision, source_text, module_json FROM modules WHERE id=?")
                    .bind("legacy-module")
                    .fetch_one(&mut connection)
                    .await
                    .expect("legacy module should survive migration");
            assert_eq!(row.get::<i64, _>("revision"), 4);
            assert_eq!(row.get::<String, _>("source_text"), "legacy source");
            assert_eq!(row.get::<String, _>("module_json"), legacy_json);

            let corrupt_row =
                sqlx::query("SELECT revision, source_text, module_json FROM modules WHERE id=?")
                    .bind("corrupt-module")
                    .fetch_one(&mut connection)
                    .await
                    .expect("migration should preserve malformed legacy rows instead of aborting");
            assert_eq!(corrupt_row.get::<i64, _>("revision"), 1);
            assert_eq!(corrupt_row.get::<String, _>("source_text"), "recover me");
            assert_eq!(
                corrupt_row.get::<String, _>("module_json"),
                "not valid JSON"
            );

            sqlx::query(
                "INSERT INTO modules (id, revision, title, schema_version, source_text, module_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind("legacy-module")
            .bind(5_i64)
            .bind("Legacy v5")
            .bind(1_i64)
            .bind("new source")
            .bind("{}")
            .bind("2026-01-01T00:00:00.000Z")
            .bind("2026-01-05T00:00:00.000Z")
            .execute(&mut connection)
            .await
            .expect("same module id should accept a newer revision");

            let revision_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM modules WHERE id=?")
                .bind("legacy-module")
                .fetch_one(&mut connection)
                .await
                .expect("history should be queryable");
            assert_eq!(revision_count, 2);

            let duplicate = sqlx::query(
                "INSERT INTO modules (id, revision, title, schema_version, source_text, module_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind("legacy-module")
            .bind(5_i64)
            .bind("Duplicate")
            .bind(1_i64)
            .bind("")
            .bind("{}")
            .bind("2026-01-01T00:00:00.000Z")
            .bind("2026-01-05T00:00:00.000Z")
            .execute(&mut connection)
            .await;
            assert!(
                duplicate.is_err(),
                "composite key must reject an exact duplicate revision"
            );
        });
    }
}
