use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::State;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use tokio::time::{timeout_at, Instant};
use zeroize::Zeroizing;

#[cfg(target_os = "windows")]
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

#[cfg(target_os = "windows")]
use windows_sys::Win32::{
    Foundation::CloseHandle,
    System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE},
    },
};

const KEYRING_SERVICE: &str = "org.coc-room.desktop";
const KEYRING_ACCOUNT: &str = "deepseek-api-key";
const NPC_REPLY_TIMEOUT: Duration = Duration::from_secs(120);
const SIDECAR_STDIN_TIMEOUT: Duration = Duration::from_secs(15);
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(100);
const MAX_NPC_REPLY_REQUEST_BYTES: usize = 2 * 1024 * 1024;
const MAX_NPC_REPLY_STDOUT_BYTES: usize = 256 * 1024;
const MAX_NPC_REPLY_STDERR_BYTES: usize = 64 * 1024;
const MAX_CONCURRENT_NPC_REPLIES: usize = 4;
const MAX_PINS: usize = 12;
const MAX_PIN_CHARS: usize = 120_000;
const MAX_MESSAGES: usize = 40;
const MAX_MESSAGE_CHARS: usize = 24_000;

#[derive(Default)]
pub(crate) struct NpcReplyExecutionState {
    active: AtomicUsize,
    cancellations: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl NpcReplyExecutionState {
    fn acquire(&self, request_id: &str) -> Result<NpcReplyPermit<'_>, String> {
        let previous = self.active.fetch_add(1, Ordering::AcqRel);
        if previous >= MAX_CONCURRENT_NPC_REPLIES {
            self.active.fetch_sub(1, Ordering::AcqRel);
            return Err("NPC 自动回复并发已达到上限".to_string());
        }
        let cancellation = Arc::new(AtomicBool::new(false));
        let mut cancellations = match self.cancellations.lock() {
            Ok(cancellations) => cancellations,
            Err(_) => {
                self.active.fetch_sub(1, Ordering::AcqRel);
                return Err("NPC 回复取消状态不可用".to_string());
            }
        };
        if cancellations.contains_key(request_id) {
            self.active.fetch_sub(1, Ordering::AcqRel);
            return Err("NPC 回复任务 ID 已在运行".to_string());
        }
        cancellations.insert(request_id.to_string(), Arc::clone(&cancellation));
        drop(cancellations);
        Ok(NpcReplyPermit {
            request_id: request_id.to_string(),
            cancellation,
            state: self,
        })
    }
}

struct NpcReplyPermit<'a> {
    request_id: String,
    cancellation: Arc<AtomicBool>,
    state: &'a NpcReplyExecutionState,
}

impl NpcReplyPermit<'_> {
    fn cancelled(&self) -> bool {
        self.cancellation.load(Ordering::Acquire)
    }
}

impl Drop for NpcReplyPermit<'_> {
    fn drop(&mut self) {
        if let Ok(mut cancellations) = self.state.cancellations.lock() {
            cancellations.remove(&self.request_id);
        }
        self.state.active.fetch_sub(1, Ordering::AcqRel);
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct NpcReplyCharacter {
    characteristics: HashMap<String, i64>,
    skills: HashMap<String, i64>,
    hit_points: Option<i64>,
    sanity: Option<i64>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct NpcReplyCard {
    id: String,
    name: String,
    description: String,
    player_description: Option<String>,
    role: String,
    motivations: Vec<String>,
    traits: Vec<String>,
    character: Option<NpcReplyCharacter>,
    // The host adapter deliberately sends no source positions to a dialogue model.
    source_refs: Vec<Value>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct NpcReplyPin {
    id: String,
    title: String,
    content: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct NpcReplyPanelMessage {
    id: String,
    role: String,
    content: String,
    sender_label: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct NpcReplyRequest {
    id: String,
    action: String,
    provider: String,
    model: String,
    npc_card: NpcReplyCard,
    pins: Vec<NpcReplyPin>,
    messages: Vec<NpcReplyPanelMessage>,
}

#[derive(Serialize)]
struct SidecarNpcReplyRequest<'a> {
    id: &'a str,
    action: &'static str,
    provider: &'a str,
    model: &'a str,
    npc_card: &'a NpcReplyCard,
    pins: &'a [NpcReplyPin],
    messages: &'a [NpcReplyPanelMessage],
    api_key: Option<&'a str>,
    codex_executable: Option<&'a str>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CharacterDraftRequest {
    id: String,
    action: String,
    provider: String,
    model: String,
    prompt: String,
    player_name: String,
    owner_seat_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SidecarCharacterDraftRequest<'a> {
    id: &'a str,
    action: &'static str,
    provider: &'a str,
    model: &'a str,
    prompt: &'a str,
    player_name: &'a str,
    owner_seat_id: &'a str,
    api_key: Option<&'a str>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NpcStatsDraftRequest {
    id: String,
    action: String,
    provider: String,
    model: String,
    npc_id: String,
    name: String,
    description: String,
    guidance: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SidecarNpcStatsDraftRequest<'a> {
    id: &'a str,
    action: &'static str,
    provider: &'a str,
    model: &'a str,
    npc_id: &'a str,
    name: &'a str,
    description: &'a str,
    guidance: &'a str,
    api_key: Option<&'a str>,
}

#[tauri::command]
pub(crate) fn cancel_npc_reply(
    execution: State<'_, NpcReplyExecutionState>,
    request_id: String,
) -> Result<bool, String> {
    cancel_text_ai_job(&execution, &request_id)
}

#[tauri::command]
pub(crate) fn cancel_character_draft(
    execution: State<'_, NpcReplyExecutionState>,
    request_id: String,
) -> Result<bool, String> {
    cancel_text_ai_job(&execution, &request_id)
}

#[tauri::command]
pub(crate) fn cancel_npc_stats_draft(
    execution: State<'_, NpcReplyExecutionState>,
    request_id: String,
) -> Result<bool, String> {
    cancel_text_ai_job(&execution, &request_id)
}

fn cancel_text_ai_job(
    execution: &NpcReplyExecutionState,
    request_id: &str,
) -> Result<bool, String> {
    validate_request_id(request_id)?;
    let cancellation = execution
        .cancellations
        .lock()
        .map_err(|_| "NPC 回复取消状态不可用".to_string())?
        .get(request_id)
        .cloned();
    let Some(cancellation) = cancellation else {
        return Ok(false);
    };
    cancellation.store(true, Ordering::Release);
    Ok(true)
}

#[tauri::command]
pub(crate) async fn run_npc_reply(
    app: tauri::AppHandle,
    execution: State<'_, NpcReplyExecutionState>,
    request: NpcReplyRequest,
) -> Result<Vec<Value>, String> {
    validate_request(&request)?;
    let permit = execution.acquire(&request.id)?;
    let deadline = Instant::now() + NPC_REPLY_TIMEOUT;

    let codex_executable =
        if request.provider == "codex" {
            Some(find_codex_executable().ok_or_else(|| {
                "未找到 Codex CLI；请先安装 Codex 或 OpenAI VS Code 扩展".to_string()
            })?)
        } else {
            None
        };
    let codex_executable_text = codex_executable
        .as_deref()
        .map(path_to_string)
        .transpose()?;
    let api_key = if request.provider == "deepseek" {
        Some(Zeroizing::new(
            Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
                .map_err(|_| "无法访问 Windows Credential Manager".to_string())?
                .get_password()
                .map_err(|_| "尚未保存 DeepSeek API Key".to_string())?,
        ))
    } else {
        None
    };

    let serialized = Zeroizing::new(
        serde_json::to_string(&SidecarNpcReplyRequest {
            id: &request.id,
            action: "generate_npc_reply",
            provider: &request.provider,
            model: &request.model,
            npc_card: &request.npc_card,
            pins: &request.pins,
            messages: &request.messages,
            api_key: api_key.as_deref().map(String::as_str),
            codex_executable: codex_executable_text.as_deref(),
        })
        .map_err(|_| "无法序列化 NPC 回复请求".to_string())?,
    );
    if serialized.len() > MAX_NPC_REPLY_REQUEST_BYTES {
        return Err("NPC 回复请求超过安全上限".to_string());
    }
    if permit.cancelled() {
        return Err("NPC 回复已取消".to_string());
    }

    let sidecar = app
        .shell()
        .sidecar("module-parser")
        .map_err(|_| "无法加载 NPC 回复 sidecar".to_string())?
        .set_raw_out(true);
    let (mut receiver, child) = sidecar
        .spawn()
        .map_err(|_| "无法启动 NPC 回复 sidecar".to_string())?;
    let mut child = NpcSidecarChildGuard::new(child)?;
    let mut stdin_payload = Zeroizing::new(Vec::with_capacity(serialized.len() + 1));
    stdin_payload.extend_from_slice(serialized.as_bytes());
    stdin_payload.push(b'\n');
    #[cfg(target_os = "windows")]
    child
        .write_with_deadline(
            stdin_payload,
            deadline.min(Instant::now() + SIDECAR_STDIN_TIMEOUT),
        )
        .await?;
    #[cfg(not(target_os = "windows"))]
    child.write(stdin_payload.as_slice())?;
    drop(serialized);
    drop(api_key);

    let mut stdout = Vec::new();
    let mut stdout_cursor = 0;
    let mut messages = Vec::new();
    let mut stderr_bytes = 0usize;
    loop {
        if permit.cancelled() {
            return Err("NPC 回复已取消".to_string());
        }
        let now = Instant::now();
        if now >= deadline {
            return Err("NPC 回复超时，已终止执行器".to_string());
        }
        let poll_deadline = deadline.min(now + CANCEL_POLL_INTERVAL);
        let event = match timeout_at(poll_deadline, receiver.recv()).await {
            Ok(Some(event)) => event,
            Ok(None) => return Err("NPC 回复 sidecar 通信异常".to_string()),
            Err(_) => continue,
        };
        match event {
            CommandEvent::Stdout(bytes) => {
                append_bytes_bounded(&mut stdout, &bytes, MAX_NPC_REPLY_STDOUT_BYTES)?;
                for message in parse_jsonl_messages(&stdout, &mut stdout_cursor, false)? {
                    validate_sidecar_message(&message, &request.id)?;
                    messages.push(message);
                }
            }
            CommandEvent::Stderr(bytes) => {
                stderr_bytes = stderr_bytes
                    .checked_add(bytes.len())
                    .filter(|size| *size <= MAX_NPC_REPLY_STDERR_BYTES)
                    .ok_or_else(|| "NPC 回复 sidecar 错误输出超过安全上限".to_string())?;
            }
            CommandEvent::Error(_) => return Err("NPC 回复 sidecar 通信异常".to_string()),
            CommandEvent::Terminated(status) => {
                child.disarm();
                if status.code != Some(0) {
                    return Err(if stderr_bytes == 0 {
                        "NPC 回复 sidecar 异常退出"
                    } else {
                        "NPC 回复 sidecar 异常退出（stderr 已脱敏）"
                    }
                    .to_string());
                }
                break;
            }
            _ => return Err("NPC 回复 sidecar 返回了未知事件".to_string()),
        }
    }

    for message in parse_jsonl_messages(&stdout, &mut stdout_cursor, true)? {
        validate_sidecar_message(&message, &request.id)?;
        messages.push(message);
    }
    if messages.len() != 1 {
        return Err("NPC 回复 sidecar 必须返回且只返回一个结果".to_string());
    }
    let message_type = messages[0].get("type").and_then(Value::as_str);
    if !matches!(message_type, Some("result" | "error")) {
        return Err("NPC 回复 sidecar 返回了非法消息类型".to_string());
    }
    Ok(messages)
}

#[tauri::command]
pub(crate) async fn run_character_draft(
    app: tauri::AppHandle,
    execution: State<'_, NpcReplyExecutionState>,
    request: CharacterDraftRequest,
) -> Result<Vec<Value>, String> {
    validate_character_draft_request(&request)?;
    let permit = execution.acquire(&request.id)?;
    let deadline = Instant::now() + NPC_REPLY_TIMEOUT;
    // The path is never serialized into the closed character task. Python's
    // dedicated executor resolves the same installed CLI again; this early
    // host check provides a deterministic capability error before spawning.
    let _codex_executable =
        if request.provider == "codex" {
            Some(find_codex_executable().ok_or_else(|| {
                "未找到 Codex CLI；请先安装 Codex 或 OpenAI VS Code 扩展".to_string()
            })?)
        } else {
            None
        };
    let api_key = if request.provider == "deepseek" {
        Some(Zeroizing::new(
            Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
                .map_err(|_| "无法访问 Windows Credential Manager".to_string())?
                .get_password()
                .map_err(|_| "尚未保存 DeepSeek API Key".to_string())?,
        ))
    } else {
        None
    };
    let serialized = Zeroizing::new(
        serde_json::to_string(&SidecarCharacterDraftRequest {
            id: &request.id,
            action: "generate_character_draft",
            provider: &request.provider,
            model: &request.model,
            prompt: &request.prompt,
            player_name: &request.player_name,
            owner_seat_id: &request.owner_seat_id,
            api_key: api_key.as_deref().map(String::as_str),
        })
        .map_err(|_| "无法序列化角色草稿请求".to_string())?,
    );
    if serialized.len() > MAX_NPC_REPLY_REQUEST_BYTES {
        return Err("角色草稿请求超过安全上限".to_string());
    }
    if permit.cancelled() {
        return Err("角色草稿已取消".to_string());
    }

    let sidecar = app
        .shell()
        .sidecar("module-parser")
        .map_err(|_| "无法加载角色草稿 sidecar".to_string())?
        .set_raw_out(true);
    let (mut receiver, child) = sidecar
        .spawn()
        .map_err(|_| "无法启动角色草稿 sidecar".to_string())?;
    let mut child = NpcSidecarChildGuard::new(child)?;
    let mut stdin_payload = Zeroizing::new(Vec::with_capacity(serialized.len() + 1));
    stdin_payload.extend_from_slice(serialized.as_bytes());
    stdin_payload.push(b'\n');
    #[cfg(target_os = "windows")]
    child
        .write_with_deadline(
            stdin_payload,
            deadline.min(Instant::now() + SIDECAR_STDIN_TIMEOUT),
        )
        .await?;
    #[cfg(not(target_os = "windows"))]
    child.write(stdin_payload.as_slice())?;
    drop(serialized);
    drop(api_key);

    let mut stdout = Vec::new();
    let mut stdout_cursor = 0;
    let mut messages = Vec::new();
    let mut stderr_bytes = 0usize;
    loop {
        if permit.cancelled() {
            return Err("角色草稿已取消".to_string());
        }
        let now = Instant::now();
        if now >= deadline {
            return Err("角色草稿超时，已终止执行器".to_string());
        }
        let poll_deadline = deadline.min(now + CANCEL_POLL_INTERVAL);
        let event = match timeout_at(poll_deadline, receiver.recv()).await {
            Ok(Some(event)) => event,
            Ok(None) => return Err("角色草稿 sidecar 通信异常".to_string()),
            Err(_) => continue,
        };
        match event {
            CommandEvent::Stdout(bytes) => {
                append_bytes_bounded(&mut stdout, &bytes, MAX_NPC_REPLY_STDOUT_BYTES)?;
                for message in parse_jsonl_messages(&stdout, &mut stdout_cursor, false)? {
                    validate_sidecar_message(&message, &request.id)?;
                    messages.push(message);
                }
            }
            CommandEvent::Stderr(bytes) => {
                stderr_bytes = stderr_bytes
                    .checked_add(bytes.len())
                    .filter(|size| *size <= MAX_NPC_REPLY_STDERR_BYTES)
                    .ok_or_else(|| "角色草稿 sidecar 错误输出超过安全上限".to_string())?;
            }
            CommandEvent::Error(_) => return Err("角色草稿 sidecar 通信异常".to_string()),
            CommandEvent::Terminated(status) => {
                child.disarm();
                if status.code != Some(0) {
                    return Err(if stderr_bytes == 0 {
                        "角色草稿 sidecar 异常退出"
                    } else {
                        "角色草稿 sidecar 异常退出（stderr 已脱敏）"
                    }
                    .to_string());
                }
                break;
            }
            _ => return Err("角色草稿 sidecar 返回了未知事件".to_string()),
        }
    }
    for message in parse_jsonl_messages(&stdout, &mut stdout_cursor, true)? {
        validate_sidecar_message(&message, &request.id)?;
        messages.push(message);
    }
    if messages.len() != 1 {
        return Err("角色草稿 sidecar 必须返回且只返回一个结果".to_string());
    }
    let message_type = messages[0].get("type").and_then(Value::as_str);
    if !matches!(message_type, Some("result" | "error")) {
        return Err("角色草稿 sidecar 返回了非法消息类型".to_string());
    }
    Ok(messages)
}

#[tauri::command]
pub(crate) async fn run_npc_stats_draft(
    app: tauri::AppHandle,
    execution: State<'_, NpcReplyExecutionState>,
    request: NpcStatsDraftRequest,
) -> Result<Vec<Value>, String> {
    validate_npc_stats_draft_request(&request)?;
    let permit = execution.acquire(&request.id)?;
    let deadline = Instant::now() + NPC_REPLY_TIMEOUT;
    // The fixed sidecar task resolves Codex itself. No executable path, file path,
    // room state, or arbitrary provider setting is accepted from the webview.
    let _codex_executable =
        if request.provider == "codex" {
            Some(find_codex_executable().ok_or_else(|| {
                "未找到 Codex CLI；请先安装 Codex 或 OpenAI VS Code 扩展".to_string()
            })?)
        } else {
            None
        };
    let api_key = if request.provider == "deepseek" {
        Some(Zeroizing::new(
            Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
                .map_err(|_| "无法访问 Windows Credential Manager".to_string())?
                .get_password()
                .map_err(|_| "尚未保存 DeepSeek API Key".to_string())?,
        ))
    } else {
        None
    };
    let serialized = Zeroizing::new(
        serde_json::to_string(&SidecarNpcStatsDraftRequest {
            id: &request.id,
            action: "generate_npc_stats_draft",
            provider: &request.provider,
            model: &request.model,
            npc_id: &request.npc_id,
            name: &request.name,
            description: &request.description,
            guidance: &request.guidance,
            api_key: api_key.as_deref().map(String::as_str),
        })
        .map_err(|_| "无法序列化 NPC 属性草稿请求".to_string())?,
    );
    if serialized.len() > MAX_NPC_REPLY_REQUEST_BYTES {
        return Err("NPC 属性草稿请求超过安全上限".to_string());
    }
    if permit.cancelled() {
        return Err("NPC 属性草稿已取消".to_string());
    }

    let sidecar = app
        .shell()
        .sidecar("module-parser")
        .map_err(|_| "无法加载 NPC 属性草稿 sidecar".to_string())?
        .set_raw_out(true);
    let (mut receiver, child) = sidecar
        .spawn()
        .map_err(|_| "无法启动 NPC 属性草稿 sidecar".to_string())?;
    let mut child = NpcSidecarChildGuard::new(child)?;
    let mut stdin_payload = Zeroizing::new(Vec::with_capacity(serialized.len() + 1));
    stdin_payload.extend_from_slice(serialized.as_bytes());
    stdin_payload.push(b'\n');
    #[cfg(target_os = "windows")]
    child
        .write_with_deadline(
            stdin_payload,
            deadline.min(Instant::now() + SIDECAR_STDIN_TIMEOUT),
        )
        .await?;
    #[cfg(not(target_os = "windows"))]
    child.write(stdin_payload.as_slice())?;
    drop(serialized);
    drop(api_key);

    let mut stdout = Vec::new();
    let mut stdout_cursor = 0;
    let mut messages = Vec::new();
    let mut stderr_bytes = 0usize;
    loop {
        if permit.cancelled() {
            return Err("NPC 属性草稿已取消".to_string());
        }
        let now = Instant::now();
        if now >= deadline {
            return Err("NPC 属性草稿超时，已终止执行器".to_string());
        }
        let poll_deadline = deadline.min(now + CANCEL_POLL_INTERVAL);
        let event = match timeout_at(poll_deadline, receiver.recv()).await {
            Ok(Some(event)) => event,
            Ok(None) => return Err("NPC 属性草稿 sidecar 通信异常".to_string()),
            Err(_) => continue,
        };
        match event {
            CommandEvent::Stdout(bytes) => {
                append_bytes_bounded(&mut stdout, &bytes, MAX_NPC_REPLY_STDOUT_BYTES)?;
                for message in parse_jsonl_messages(&stdout, &mut stdout_cursor, false)? {
                    validate_sidecar_message(&message, &request.id)?;
                    messages.push(message);
                }
            }
            CommandEvent::Stderr(bytes) => {
                stderr_bytes = stderr_bytes
                    .checked_add(bytes.len())
                    .filter(|size| *size <= MAX_NPC_REPLY_STDERR_BYTES)
                    .ok_or_else(|| "NPC 属性草稿 sidecar 错误输出超过安全上限".to_string())?;
            }
            CommandEvent::Error(_) => return Err("NPC 属性草稿 sidecar 通信异常".to_string()),
            CommandEvent::Terminated(status) => {
                child.disarm();
                if status.code != Some(0) {
                    return Err(if stderr_bytes == 0 {
                        "NPC 属性草稿 sidecar 异常退出"
                    } else {
                        "NPC 属性草稿 sidecar 异常退出（stderr 已脱敏）"
                    }
                    .to_string());
                }
                break;
            }
            _ => return Err("NPC 属性草稿 sidecar 返回了未知事件".to_string()),
        }
    }
    for message in parse_jsonl_messages(&stdout, &mut stdout_cursor, true)? {
        validate_sidecar_message(&message, &request.id)?;
        messages.push(message);
    }
    if messages.len() != 1 {
        return Err("NPC 属性草稿 sidecar 必须返回且只返回一个结果".to_string());
    }
    let message_type = messages[0].get("type").and_then(Value::as_str);
    if !matches!(message_type, Some("result" | "error")) {
        return Err("NPC 属性草稿 sidecar 返回了非法消息类型".to_string());
    }
    Ok(messages)
}

fn validate_npc_stats_draft_request(request: &NpcStatsDraftRequest) -> Result<(), String> {
    validate_request_id(&request.id)?;
    if request.action != "generate_npc_stats_draft" {
        return Err("不支持的 NPC 属性草稿操作".to_string());
    }
    if !matches!(request.provider.as_str(), "codex" | "deepseek") {
        return Err("不支持的 NPC 属性草稿提供者".to_string());
    }
    if request.model.len() > 100
        || !request
            .model
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".-_".contains(character))
    {
        return Err("NPC 属性草稿模型名称无效".to_string());
    }
    validate_identifier(&request.npc_id, "NPC ID")?;
    validate_text(&request.name, 1, 300, "NPC 名称")?;
    validate_text(&request.description, 0, 30_000, "NPC 描述")?;
    validate_text(&request.guidance, 0, 8_000, "NPC 补充要求")?;
    Ok(())
}

fn validate_character_draft_request(request: &CharacterDraftRequest) -> Result<(), String> {
    validate_request_id(&request.id)?;
    if request.action != "generate_character_draft" {
        return Err("不支持的角色草稿操作".to_string());
    }
    if !matches!(request.provider.as_str(), "codex" | "deepseek") {
        return Err("不支持的角色草稿提供者".to_string());
    }
    if request.model.len() > 100
        || !request
            .model
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".-_".contains(character))
    {
        return Err("角色草稿模型名称无效".to_string());
    }
    validate_text(&request.prompt, 1, 8_000, "角色草稿描述")?;
    validate_text(&request.player_name, 1, 160, "玩家名称")?;
    validate_identifier(&request.owner_seat_id, "角色归属席位")?;
    Ok(())
}

fn validate_request(request: &NpcReplyRequest) -> Result<(), String> {
    validate_request_id(&request.id)?;
    if request.action != "generate_npc_reply" {
        return Err("不支持的 NPC 回复操作".to_string());
    }
    if !matches!(request.provider.as_str(), "codex" | "deepseek") {
        return Err("不支持的 NPC 提供者".to_string());
    }
    if request.model.len() > 100
        || !request
            .model
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".-_".contains(character))
    {
        return Err("NPC 模型名称无效".to_string());
    }
    validate_identifier(&request.npc_card.id, "NPC ID")?;
    validate_text(&request.npc_card.name, 1, 300, "NPC 名称")?;
    validate_text(&request.npc_card.description, 0, 30_000, "NPC 描述")?;
    validate_optional_text(
        request.npc_card.player_description.as_deref(),
        20_000,
        "NPC 玩家描述",
    )?;
    validate_text(&request.npc_card.role, 0, 1_000, "NPC 身份")?;
    if !request.npc_card.source_refs.is_empty() {
        return Err("NPC 对话上下文不得包含原文位置".to_string());
    }
    if request.npc_card.motivations.len() > 100 || request.npc_card.traits.len() > 100 {
        return Err("NPC 设定列表超过安全上限".to_string());
    }
    if let Some(character) = &request.npc_card.character {
        if character
            .characteristics
            .values()
            .chain(character.skills.values())
            .any(|value| !(0..=100).contains(value))
            || character
                .hit_points
                .is_some_and(|value| !(0..=99).contains(&value))
            || character
                .sanity
                .is_some_and(|value| !(0..=100).contains(&value))
        {
            return Err("NPC 数值超出 CoC 百分值范围".to_string());
        }
    }

    if request.pins.len() > MAX_PINS {
        return Err("NPC 上下文最多挂载 12 条资料".to_string());
    }
    let mut pin_chars = 0usize;
    for pin in &request.pins {
        validate_identifier(&pin.id, "NPC 挂载资料 ID")?;
        validate_text(&pin.title, 1, 300, "NPC 挂载资料标题")?;
        validate_text(&pin.content, 1, 20_000, "NPC 挂载资料正文")?;
        pin_chars = pin_chars
            .checked_add(pin.title.chars().count() + pin.content.chars().count())
            .ok_or_else(|| "NPC 挂载资料超过安全上限".to_string())?;
    }
    if pin_chars > MAX_PIN_CHARS {
        return Err("NPC 挂载资料超过字符上限".to_string());
    }

    if request.messages.len() > MAX_MESSAGES {
        return Err("NPC 面板上下文最多包含 40 条消息".to_string());
    }
    let mut message_chars = 0usize;
    for message in &request.messages {
        validate_identifier(&message.id, "NPC 面板消息 ID")?;
        if !matches!(message.role.as_str(), "human" | "npc") {
            return Err("NPC 面板上下文只接受 human 或 npc 消息".to_string());
        }
        validate_text(&message.content, 1, MAX_MESSAGE_CHARS, "NPC 面板消息")?;
        validate_optional_text(message.sender_label.as_deref(), 200, "NPC 消息发送者")?;
        message_chars = message_chars
            .checked_add(message.content.chars().count())
            .ok_or_else(|| "NPC 消息上下文超过安全上限".to_string())?;
    }
    if message_chars > MAX_MESSAGE_CHARS {
        return Err("NPC 面板上下文超过 24,000 字符".to_string());
    }
    Ok(())
}

fn validate_request_id(value: &str) -> Result<(), String> {
    let bytes = value.as_bytes();
    if bytes.len() != 36
        || ![8usize, 13, 18, 23]
            .iter()
            .all(|index| bytes[*index] == b'-')
        || bytes.iter().enumerate().any(|(index, byte)| {
            ![8usize, 13, 18, 23].contains(&index) && !byte.is_ascii_hexdigit()
        })
    {
        return Err("NPC 回复任务 ID 必须是 UUID".to_string());
    }
    Ok(())
}

fn validate_identifier(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && b"._:-".contains(&byte))
        })
    {
        return Err(format!("{label} 无效"));
    }
    Ok(())
}

fn validate_text(value: &str, minimum: usize, maximum: usize, label: &str) -> Result<(), String> {
    let length = value.chars().count();
    if length < minimum || length > maximum || value.chars().any(|character| character == '\0') {
        return Err(format!("{label} 长度无效"));
    }
    Ok(())
}

fn validate_optional_text(value: Option<&str>, maximum: usize, label: &str) -> Result<(), String> {
    if let Some(value) = value {
        validate_text(value, 0, maximum, label)?;
    }
    Ok(())
}

fn find_codex_executable() -> Option<PathBuf> {
    if let Some(path_value) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path_value) {
            #[cfg(target_os = "windows")]
            let candidate = directory.join("codex.exe");
            #[cfg(not(target_os = "windows"))]
            let candidate = directory.join("codex");
            if candidate.is_file() {
                if let Ok(canonical) = candidate.canonicalize() {
                    return Some(canonical);
                }
            }
        }
    }
    #[cfg(target_os = "windows")]
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        let mut candidates = Vec::new();
        for extension_root in [".vscode/extensions", ".vscode-insiders/extensions"] {
            let root = PathBuf::from(&profile).join(extension_root);
            let Ok(entries) = std::fs::read_dir(root) else {
                continue;
            };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                if !name.starts_with("openai.chatgpt-") || !name.ends_with("-win32-x64") {
                    continue;
                }
                let candidate = entry.path().join("bin/windows-x86_64/codex.exe");
                if candidate.is_file() {
                    candidates.push(candidate);
                }
            }
        }
        candidates.sort_by_key(|path| {
            path.metadata()
                .and_then(|metadata| metadata.modified())
                .ok()
        });
        if let Some(candidate) = candidates.pop() {
            return candidate.canonicalize().ok();
        }
    }
    None
}

fn path_to_string(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(str::to_string)
        .ok_or_else(|| "Codex 可执行文件路径不是有效 UTF-8".to_string())
}

fn append_bytes_bounded(buffer: &mut Vec<u8>, bytes: &[u8], limit: usize) -> Result<(), String> {
    let new_len = buffer
        .len()
        .checked_add(bytes.len())
        .filter(|length| *length <= limit)
        .ok_or_else(|| "NPC 回复 sidecar 输出超过安全上限".to_string())?;
    buffer.reserve(new_len.saturating_sub(buffer.len()));
    buffer.extend_from_slice(bytes);
    Ok(())
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
            .map_err(|_| "NPC 回复 sidecar 返回了非 UTF-8 输出".to_string())?
            .trim_end_matches('\r')
            .trim();
        *cursor = next_cursor;
        if !line.is_empty() {
            messages.push(
                serde_json::from_str::<Value>(line)
                    .map_err(|_| "NPC 回复 sidecar 返回了非法 JSONL".to_string())?,
            );
        }
    }
    Ok(messages)
}

fn validate_sidecar_message(message: &Value, request_id: &str) -> Result<(), String> {
    if message.get("request_id").and_then(Value::as_str) != Some(request_id) {
        return Err("NPC 回复 sidecar 返回了不匹配的任务 ID".to_string());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
struct NpcParserJobObject {
    handle: Option<OwnedHandle>,
}

#[cfg(target_os = "windows")]
impl NpcParserJobObject {
    fn assign(process_id: u32) -> Result<Self, String> {
        // SAFETY: all Win32 handles are null-checked and owned/closed on every path.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err("无法创建 NPC 回复进程作业".to_string());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                CloseHandle(job);
                return Err("无法配置 NPC 回复进程作业".to_string());
            }
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, process_id);
            if process.is_null() {
                CloseHandle(job);
                return Err("无法打开 NPC 回复进程".to_string());
            }
            let assigned = AssignProcessToJobObject(job, process);
            CloseHandle(process);
            if assigned == 0 {
                CloseHandle(job);
                return Err("无法隔离 NPC 回复进程树".to_string());
            }
            Ok(Self {
                handle: Some(OwnedHandle::from_raw_handle(job)),
            })
        }
    }

    fn terminate(&mut self) {
        if let Some(handle) = self.handle.take() {
            // SAFETY: handle is a live Job Object owned by this value.
            unsafe {
                TerminateJobObject(handle.as_raw_handle(), 1);
            }
            drop(handle);
        }
    }
}

struct NpcSidecarChildGuard {
    child: Option<CommandChild>,
    #[cfg(target_os = "windows")]
    job: NpcParserJobObject,
}

impl NpcSidecarChildGuard {
    fn new(child: CommandChild) -> Result<Self, String> {
        #[cfg(target_os = "windows")]
        {
            let job = match NpcParserJobObject::assign(child.pid()) {
                Ok(job) => job,
                Err(error) => {
                    let _ = child.kill();
                    return Err(error);
                }
            };
            Ok(Self {
                child: Some(child),
                job,
            })
        }
        #[cfg(not(target_os = "windows"))]
        {
            Ok(Self { child: Some(child) })
        }
    }

    #[cfg(target_os = "windows")]
    async fn write_with_deadline(
        &mut self,
        payload: Zeroizing<Vec<u8>>,
        deadline: Instant,
    ) -> Result<(), String> {
        let child = self
            .child
            .take()
            .ok_or_else(|| "NPC 回复 sidecar 不可用".to_string())?;
        let mut writer = tokio::task::spawn_blocking(move || {
            let mut child = child;
            let result = child
                .write(payload.as_slice())
                .map_err(|_| "无法写入 NPC 回复请求".to_string());
            (child, result)
        });
        match timeout_at(deadline, &mut writer).await {
            Ok(Ok((child, result))) => {
                self.child = Some(child);
                result
            }
            Ok(Err(_)) => {
                self.job.terminate();
                Err("NPC 回复写入任务异常".to_string())
            }
            Err(_) => {
                self.job.terminate();
                if let Ok((child, _)) = writer.await {
                    self.child = Some(child);
                }
                Err("NPC 回复请求写入超时".to_string())
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    fn write(&mut self, payload: &[u8]) -> Result<(), String> {
        self.child
            .as_mut()
            .ok_or_else(|| "NPC 回复 sidecar 不可用".to_string())?
            .write(payload)
            .map_err(|_| "无法写入 NPC 回复请求".to_string())
    }

    fn disarm(&mut self) {
        drop(self.child.take());
    }

    fn kill(&mut self) {
        #[cfg(target_os = "windows")]
        self.job.terminate();
        if let Some(child) = self.child.take() {
            let _ = child.kill();
        }
    }
}

impl Drop for NpcSidecarChildGuard {
    fn drop(&mut self) {
        self.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> NpcReplyRequest {
        NpcReplyRequest {
            id: "00000000-0000-4000-8000-000000000001".to_string(),
            action: "generate_npc_reply".to_string(),
            provider: "codex".to_string(),
            model: String::new(),
            npc_card: NpcReplyCard {
                id: "npc-one".to_string(),
                name: "Keeper".to_string(),
                description: "Quiet".to_string(),
                player_description: None,
                role: String::new(),
                motivations: Vec::new(),
                traits: Vec::new(),
                character: None,
                source_refs: Vec::new(),
            },
            pins: Vec::new(),
            messages: vec![NpcReplyPanelMessage {
                id: "message-one".to_string(),
                role: "human".to_string(),
                content: "Hello".to_string(),
                sender_label: None,
            }],
        }
    }

    #[test]
    fn validates_the_narrow_request_shape() {
        assert!(validate_request(&request()).is_ok());
        let mut candidate = request();
        candidate.messages.push(NpcReplyPanelMessage {
            id: "message-secret".to_string(),
            role: "system".to_string(),
            content: "room context".to_string(),
            sender_label: None,
        });
        assert!(validate_request(&candidate).is_err());
    }

    #[test]
    fn rejects_more_than_twenty_four_thousand_unicode_characters() {
        let mut candidate = request();
        candidate.messages[0].content = "🦋".repeat(MAX_MESSAGE_CHARS + 1);
        assert!(validate_request(&candidate).is_err());
    }

    #[test]
    fn rejects_source_locations_from_dialogue_context() {
        let mut candidate = request();
        candidate.npc_card.source_refs.push(serde_json::json!({
            "chunk_id": "secret",
            "start": 1,
            "end": 2,
        }));
        assert!(validate_request(&candidate).is_err());
    }

    #[test]
    fn character_draft_accepts_only_the_five_story_and_provider_fields() {
        let candidate = CharacterDraftRequest {
            id: "00000000-0000-4000-8000-000000000002".to_string(),
            action: "generate_character_draft".to_string(),
            provider: "codex".to_string(),
            model: String::new(),
            prompt: "A cautious antiquarian".to_string(),
            player_name: "Investigator".to_string(),
            owner_seat_id: "seat-one".to_string(),
        };
        assert!(validate_character_draft_request(&candidate).is_ok());

        let unsafe_payload = serde_json::json!({
            "id": "00000000-0000-4000-8000-000000000002",
            "action": "generate_character_draft",
            "provider": "codex",
            "model": "",
            "prompt": "A cautious antiquarian",
            "playerName": "Investigator",
            "ownerSeatId": "seat-one",
            "path": "C:/keeper/secrets",
        });
        assert!(serde_json::from_value::<CharacterDraftRequest>(unsafe_payload).is_err());
    }

    #[test]
    fn npc_stats_draft_accepts_only_the_fixed_local_fields() {
        let candidate = NpcStatsDraftRequest {
            id: "00000000-0000-4000-8000-000000000003".to_string(),
            action: "generate_npc_stats_draft".to_string(),
            provider: "codex".to_string(),
            model: String::new(),
            npc_id: "npc-watchman".to_string(),
            name: "Watchman".to_string(),
            description: "A museum guard".to_string(),
            guidance: "Former soldier".to_string(),
        };
        assert!(validate_npc_stats_draft_request(&candidate).is_ok());

        let unsafe_payload = serde_json::json!({
            "id": "00000000-0000-4000-8000-000000000003",
            "action": "generate_npc_stats_draft",
            "provider": "codex",
            "model": "",
            "npcId": "npc-watchman",
            "name": "Watchman",
            "description": "A museum guard",
            "guidance": "Former soldier",
            "roomContext": { "keeperNotes": "secret" },
        });
        assert!(serde_json::from_value::<NpcStatsDraftRequest>(unsafe_payload).is_err());
    }
}
