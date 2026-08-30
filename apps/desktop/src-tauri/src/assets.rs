use image::{
    codecs::webp::WebPEncoder, imageops::FilterType, DynamicImage, GenericImageView, ImageEncoder,
    ImageFormat, ImageReader,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Pool, Row, Sqlite};
use std::{
    fs::{self, File, OpenOptions},
    io::{Cursor, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    sync::OnceLock,
};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_sql::{DbInstances, DbPool};
use tempfile::NamedTempFile;

const DATABASE_URL: &str = "sqlite:coc-room.db";
const ASSET_DIRECTORY: &str = "assets";
const HASH_DIRECTORY: &str = "sha256";
const TEMP_DIRECTORY: &str = ".tmp";
const MAX_IMAGE_SOURCE_BYTES: usize = 25 * 1024 * 1024;
const MAX_IMAGE_ASSET_BYTES: usize = 8 * 1024 * 1024;
const MAX_AUDIO_ASSET_BYTES: usize = 64 * 1024 * 1024;
const MAX_IMAGE_EDGE: u32 = 8_192;
const MAX_IMAGE_PIXELS: u64 = 32_000_000;
const MAX_ASSET_CHUNK_BYTES: usize = 64 * 1024;
const ROOM_ASSET_CHUNK_BYTES: usize = 24 * 1024;
const MAX_AUDIO_PROBE_BYTES: usize = 64 * 1024;
const MAX_OWNER_REVISION: i64 = 2_147_483_647;
const ASSET_OWNER_TYPES: &[&str] = &[
    "module",
    "room",
    "board",
    "artifact",
    "scene",
    "location",
    "npc",
    "clue",
    "handout",
    "character",
];

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum AssetMediaKind {
    Image,
    Audio,
}

impl AssetMediaKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Audio => "audio",
        }
    }

    fn source_limit(self) -> usize {
        match self {
            Self::Image => MAX_IMAGE_SOURCE_BYTES,
            Self::Audio => MAX_AUDIO_ASSET_BYTES,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AssetDescriptor {
    schema_version: u8,
    asset_id: String,
    #[serde(skip)]
    media_kind: AssetMediaKind,
    media_type: String,
    byte_length: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    height: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AssetImportResult {
    asset: AssetDescriptor,
    deduplicated: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReceivedAssetDescriptor {
    schema_version: u8,
    asset_id: String,
    media_type: String,
    byte_length: u64,
    width: Option<u32>,
    height: Option<u32>,
    duration_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PersistedDownloadChunk {
    chunk_index: u32,
    bytes: Vec<u8>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PersistedAssetDownload {
    transfer_id: String,
    source_peer_id: String,
    asset: ReceivedAssetDescriptor,
    chunks: Vec<PersistedDownloadChunk>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AssetChunkRead {
    asset_id: String,
    offset: u64,
    data: Vec<u8>,
    eof: bool,
}

struct PreparedAsset {
    bytes: Vec<u8>,
    media_kind: AssetMediaKind,
    media_type: &'static str,
    extension: &'static str,
    pixel_width: Option<u32>,
    pixel_height: Option<u32>,
}

struct PersistedAsset {
    descriptor: AssetDescriptor,
    storage_key: String,
    deduplicated: bool,
}

pub(crate) fn initialize_asset_store<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<PathBuf, String> {
    let root = asset_root(app)?;
    fs::create_dir_all(&root).map_err(|error| format!("无法创建本地资产目录: {error}"))?;
    fs::create_dir_all(asset_temp_root(app)?)
        .map_err(|error| format!("无法创建本地资产目录: {error}"))?;
    app.asset_protocol_scope()
        .allow_directory(&root, true)
        .map_err(|error| format!("无法限制本地资产读取范围: {error}"))?;
    Ok(root)
}

#[tauri::command]
pub(crate) async fn select_and_import_asset(
    app: tauri::AppHandle,
    databases: State<'_, DbInstances>,
    kind: AssetMediaKind,
) -> Result<Option<AssetImportResult>, String> {
    let mut picker = app.dialog().file();
    picker = match kind {
        AssetMediaKind::Image => picker.add_filter("静态图片", &["png", "jpg", "jpeg", "webp"]),
        AssetMediaKind::Audio => picker.add_filter("音频", &["mp3", "ogg", "wav"]),
    };
    let Some(selected) = picker.blocking_pick_file() else {
        return Ok(None);
    };
    let source = selected
        .into_path()
        .map_err(|_| "文件对话框没有返回本机文件".to_string())?;
    let bytes = read_bounded_source(&source, kind.source_limit())?;
    let result = import_prepared_asset(&app, &databases, prepare_asset(kind, bytes, None)?).await?;
    Ok(Some(result))
}

/// Imports bytes already obtained from a trusted package reader. The caller's
/// media declaration is only an assertion; content sniffing remains authoritative.
#[tauri::command]
pub(crate) async fn import_asset_bytes(
    app: tauri::AppHandle,
    databases: State<'_, DbInstances>,
    kind: AssetMediaKind,
    bytes: Vec<u8>,
    declared_media_type: Option<String>,
) -> Result<AssetImportResult, String> {
    if bytes.len() > kind.source_limit() {
        return Err(asset_size_error(kind));
    }
    let prepared = prepare_asset(kind, bytes, declared_media_type.as_deref())?;
    import_prepared_asset(&app, &databases, prepared).await
}

/// Finalizes bytes reconstructed from the room transport. TypeScript verifies
/// the transfer first, but this native trust boundary independently repeats
/// all content, descriptor and hash validation without re-encoding the bytes.
#[tauri::command]
pub(crate) async fn import_received_asset(
    app: tauri::AppHandle,
    databases: State<'_, DbInstances>,
    asset: ReceivedAssetDescriptor,
    bytes: Vec<u8>,
) -> Result<AssetImportResult, String> {
    let prepared = prepare_received_asset(&asset, bytes)?;
    import_prepared_asset(&app, &databases, prepared).await
}

/// Writes a validated room-transfer chunk into a managed sparse temporary
/// file and only then records its index. The sender is ACKed after this command
/// returns, so every acknowledged chunk survives a process restart.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn persist_asset_download_chunk(
    app: tauri::AppHandle,
    databases: State<'_, DbInstances>,
    room_id: String,
    source_peer_id: String,
    transfer_id: String,
    asset: ReceivedAssetDescriptor,
    chunk_index: u32,
    chunk_count: u32,
    bytes: Vec<u8>,
) -> Result<bool, String> {
    validate_download_identity(&room_id, &source_peer_id, &transfer_id)?;
    validate_received_descriptor_metadata(&asset)?;
    let expected_count = room_asset_chunk_count(asset.byte_length)?;
    if chunk_count != expected_count || chunk_index >= chunk_count {
        return Err("Room asset chunk coordinates do not match the descriptor".to_string());
    }
    let expected_length = room_asset_chunk_length(asset.byte_length, chunk_index, chunk_count)?;
    if bytes.len() != expected_length {
        return Err("Room asset chunk length does not match the descriptor".to_string());
    }
    let _download_guard = asset_download_gate().lock().await;

    let descriptor_json = serde_json::to_string(&asset)
        .map_err(|error| format!("Unable to serialize asset descriptor: {error}"))?;
    let pool = database_pool(&databases).await?;
    let existing = sqlx::query(
        r#"SELECT request_id, source_peer_id, total_bytes, chunk_size, chunk_count,
                  received_chunks_json, temp_storage_key, descriptor_json
           FROM asset_downloads WHERE room_id=? AND asset_id=?"#,
    )
    .bind(&room_id)
    .bind(&asset.asset_id)
    .fetch_optional(&pool)
    .await
    .map_err(|error| format!("Unable to inspect partial asset download: {error}"))?;

    let (storage_key, mut received): (String, Vec<u32>) = if let Some(row) = existing {
        let matches = row.get::<String, _>("request_id") == transfer_id
            && row.get::<String, _>("source_peer_id") == source_peer_id
            && row.get::<i64, _>("total_bytes") == asset.byte_length as i64
            && row.get::<i64, _>("chunk_size") == ROOM_ASSET_CHUNK_BYTES as i64
            && row.get::<i64, _>("chunk_count") == chunk_count as i64
            && row.get::<Option<String>, _>("descriptor_json").as_deref()
                == Some(descriptor_json.as_str());
        if !matches {
            return Err("Partial asset download identity or exact descriptor changed".to_string());
        }
        let indexes =
            serde_json::from_str::<Vec<u32>>(&row.get::<String, _>("received_chunks_json"))
                .map_err(|_| "Partial asset download index is corrupt".to_string())?;
        (row.get("temp_storage_key"), indexes)
    } else {
        let storage_key = download_storage_key(&room_id, &asset.asset_id);
        let path = managed_download_path(&app, &storage_key, false)?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(&path)
            .map_err(|error| format!("Unable to create partial asset file: {error}"))?;
        file.set_len(asset.byte_length)
            .and_then(|()| file.sync_all())
            .map_err(|error| format!("Unable to size partial asset file: {error}"))?;
        sqlx::query(
            r#"INSERT INTO asset_downloads (
                 room_id, asset_id, request_id, source_peer_id, total_bytes,
                 chunk_size, chunk_count, received_chunks_json, temp_storage_key,
                 state, created_at, updated_at, descriptor_json
               ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, 'pending',
                 strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                 strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)"#,
        )
        .bind(&room_id)
        .bind(&asset.asset_id)
        .bind(&transfer_id)
        .bind(&source_peer_id)
        .bind(asset.byte_length as i64)
        .bind(ROOM_ASSET_CHUNK_BYTES as i64)
        .bind(chunk_count as i64)
        .bind(&storage_key)
        .bind(&descriptor_json)
        .execute(&pool)
        .await
        .map_err(|error| format!("Unable to create partial asset record: {error}"))?;
        (storage_key, Vec::new())
    };

    let path = managed_download_path(&app, &storage_key, true)?;
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&path)
        .map_err(|error| format!("Unable to open partial asset file: {error}"))?;
    let offset = u64::from(chunk_index) * ROOM_ASSET_CHUNK_BYTES as u64;
    if received.contains(&chunk_index) {
        let mut existing_bytes = vec![0_u8; expected_length];
        file.seek(SeekFrom::Start(offset))
            .and_then(|_| file.read_exact(&mut existing_bytes))
            .map_err(|error| format!("Unable to verify duplicate asset chunk: {error}"))?;
        if existing_bytes != bytes {
            return Err("Duplicate room asset chunk has conflicting bytes".to_string());
        }
        return Ok(false);
    }
    file.seek(SeekFrom::Start(offset))
        .and_then(|_| file.write_all(&bytes))
        .and_then(|()| file.sync_data())
        .map_err(|error| format!("Unable to persist room asset chunk: {error}"))?;
    received.push(chunk_index);
    received.sort_unstable();
    received.dedup();
    let received_json = serde_json::to_string(&received)
        .map_err(|error| format!("Unable to serialize asset chunk index: {error}"))?;
    sqlx::query(
        r#"UPDATE asset_downloads
           SET received_chunks_json=?, state='receiving',
               updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE room_id=? AND asset_id=? AND request_id=?"#,
    )
    .bind(received_json)
    .bind(&room_id)
    .bind(&asset.asset_id)
    .bind(&transfer_id)
    .execute(&pool)
    .await
    .map_err(|error| format!("Unable to record persisted asset chunk: {error}"))?;
    Ok(true)
}

#[tauri::command]
pub(crate) async fn load_asset_download(
    app: tauri::AppHandle,
    databases: State<'_, DbInstances>,
    room_id: String,
    source_peer_id: String,
    asset: ReceivedAssetDescriptor,
) -> Result<Option<PersistedAssetDownload>, String> {
    validate_download_identity(&room_id, &source_peer_id, "resume-check")?;
    validate_received_descriptor_metadata(&asset)?;
    let _download_guard = asset_download_gate().lock().await;
    let pool = database_pool(&databases).await?;
    let row = sqlx::query(
        r#"SELECT request_id, source_peer_id, total_bytes, chunk_size, chunk_count,
                  received_chunks_json, temp_storage_key, descriptor_json
           FROM asset_downloads WHERE room_id=? AND asset_id=?"#,
    )
    .bind(&room_id)
    .bind(&asset.asset_id)
    .fetch_optional(&pool)
    .await
    .map_err(|error| format!("Unable to load partial asset download: {error}"))?;
    let Some(row) = row else { return Ok(None) };
    let descriptor_json = serde_json::to_string(&asset)
        .map_err(|error| format!("Unable to serialize asset descriptor: {error}"))?;
    let transfer_id: String = row.get("request_id");
    validate_download_identity(&room_id, &source_peer_id, &transfer_id)?;
    let chunk_count = room_asset_chunk_count(asset.byte_length)?;
    let matches = row.get::<String, _>("source_peer_id") == source_peer_id
        && row.get::<i64, _>("total_bytes") == asset.byte_length as i64
        && row.get::<i64, _>("chunk_size") == ROOM_ASSET_CHUNK_BYTES as i64
        && row.get::<i64, _>("chunk_count") == chunk_count as i64
        && row.get::<Option<String>, _>("descriptor_json").as_deref()
            == Some(descriptor_json.as_str());
    if !matches {
        return Err(
            "Persisted download does not match the exact requested descriptor and source"
                .to_string(),
        );
    }
    let received = serde_json::from_str::<Vec<u32>>(&row.get::<String, _>("received_chunks_json"))
        .map_err(|_| "Partial asset download index is corrupt".to_string())?;
    let storage_key: String = row.get("temp_storage_key");
    let path = managed_download_path(&app, &storage_key, true)?;
    let mut file =
        File::open(path).map_err(|error| format!("Unable to open partial asset file: {error}"))?;
    if file.metadata().map_err(|error| error.to_string())?.len() != asset.byte_length {
        return Err("Partial asset file length does not match its descriptor".to_string());
    }
    let mut seen = std::collections::HashSet::new();
    let mut chunks = Vec::with_capacity(received.len());
    for chunk_index in received {
        if chunk_index >= chunk_count || !seen.insert(chunk_index) {
            return Err("Partial asset download indexes are invalid".to_string());
        }
        let length = room_asset_chunk_length(asset.byte_length, chunk_index, chunk_count)?;
        let mut bytes = vec![0_u8; length];
        file.seek(SeekFrom::Start(
            u64::from(chunk_index) * ROOM_ASSET_CHUNK_BYTES as u64,
        ))
        .and_then(|_| file.read_exact(&mut bytes))
        .map_err(|error| format!("Unable to read partial asset chunk: {error}"))?;
        chunks.push(PersistedDownloadChunk { chunk_index, bytes });
    }
    chunks.sort_by_key(|chunk| chunk.chunk_index);
    Ok(Some(PersistedAssetDownload {
        transfer_id,
        source_peer_id,
        asset,
        chunks,
    }))
}

#[tauri::command]
pub(crate) async fn discard_asset_download(
    app: tauri::AppHandle,
    databases: State<'_, DbInstances>,
    room_id: String,
    asset_id: String,
    transfer_id: String,
) -> Result<bool, String> {
    validate_asset_id(&asset_id)?;
    validate_reference_identifier(&room_id, 240, "room ID")?;
    validate_reference_identifier(&transfer_id, 128, "transfer ID")?;
    let _download_guard = asset_download_gate().lock().await;
    let pool = database_pool(&databases).await?;
    let row = sqlx::query(
        "SELECT request_id, temp_storage_key FROM asset_downloads WHERE room_id=? AND asset_id=?",
    )
    .bind(&room_id)
    .bind(&asset_id)
    .fetch_optional(&pool)
    .await
    .map_err(|error| format!("Unable to inspect partial asset download: {error}"))?;
    let Some(row) = row else { return Ok(false) };
    if row.get::<String, _>("request_id") != transfer_id {
        return Err("Transfer ID does not match the persisted download".to_string());
    }
    let storage_key: String = row.get("temp_storage_key");
    sqlx::query("DELETE FROM asset_downloads WHERE room_id=? AND asset_id=? AND request_id=?")
        .bind(&room_id)
        .bind(&asset_id)
        .bind(&transfer_id)
        .execute(&pool)
        .await
        .map_err(|error| format!("Unable to discard partial asset record: {error}"))?;
    let path = managed_download_path(&app, &storage_key, false)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(format!(
            "Partial asset record was removed but its file remains: {error}"
        )),
    }
}

#[tauri::command]
pub(crate) async fn list_unreferenced_assets(
    databases: State<'_, DbInstances>,
) -> Result<Vec<AssetDescriptor>, String> {
    let pool = database_pool(&databases).await?;
    let rows = sqlx::query(
        r#"SELECT a.asset_id, a.media_kind, a.media_type, a.byte_length,
                  a.pixel_width, a.pixel_height, a.created_at, a.last_verified_at
           FROM assets a
           WHERE NOT EXISTS (SELECT 1 FROM asset_refs r WHERE r.asset_id = a.asset_id)
             AND NOT EXISTS (SELECT 1 FROM asset_grants g WHERE g.asset_id = a.asset_id)
             AND NOT EXISTS (SELECT 1 FROM asset_downloads d WHERE d.asset_id = a.asset_id)
           ORDER BY a.created_at ASC, a.asset_id ASC"#,
    )
    .fetch_all(&pool)
    .await
    .map_err(|error| format!("无法查询未引用资产: {error}"))?;
    rows.iter().map(descriptor_from_row).collect()
}

#[tauri::command]
pub(crate) async fn add_asset_reference(
    databases: State<'_, DbInstances>,
    asset_id: String,
    owner_type: String,
    owner_id: String,
    owner_revision: i64,
    slot: String,
) -> Result<bool, String> {
    validate_asset_reference_input(&asset_id, &owner_type, &owner_id, owner_revision, &slot)?;
    let pool = database_pool(&databases).await?;
    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| format!("无法开始资产引用事务: {error}"))?;
    let exists = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM assets WHERE asset_id=?")
        .bind(&asset_id)
        .fetch_one(&mut *transaction)
        .await
        .map_err(|error| format!("无法确认待引用资产: {error}"))?;
    if exists != 1 {
        return Err("本机没有待引用的资产".to_string());
    }
    let inserted = sqlx::query(
        r#"INSERT INTO asset_refs (
             asset_id, owner_type, owner_id, owner_revision, slot, created_at
           ) VALUES (
             ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now')
           ) ON CONFLICT(owner_type, owner_id, owner_revision, slot, asset_id)
           DO NOTHING"#,
    )
    .bind(&asset_id)
    .bind(&owner_type)
    .bind(&owner_id)
    .bind(owner_revision)
    .bind(&slot)
    .execute(&mut *transaction)
    .await
    .map_err(|error| format!("无法保存资产引用: {error}"))?
    .rows_affected()
        == 1;
    transaction
        .commit()
        .await
        .map_err(|error| format!("无法提交资产引用事务: {error}"))?;
    Ok(inserted)
}

#[tauri::command]
pub(crate) async fn delete_unreferenced_asset(
    app: tauri::AppHandle,
    databases: State<'_, DbInstances>,
    asset_id: String,
) -> Result<bool, String> {
    validate_asset_id(&asset_id)?;
    let pool = database_pool(&databases).await?;
    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| format!("无法开始资产删除事务: {error}"))?;
    let storage_key =
        sqlx::query_scalar::<_, String>("SELECT storage_key FROM assets WHERE asset_id=?")
            .bind(&asset_id)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(|error| format!("无法查询资产: {error}"))?;
    let Some(storage_key) = storage_key else {
        return Ok(false);
    };
    validate_storage_key(&asset_id, &storage_key)?;

    let deleted = sqlx::query(
        r#"DELETE FROM assets
           WHERE asset_id=?
             AND NOT EXISTS (SELECT 1 FROM asset_refs r WHERE r.asset_id=assets.asset_id)
             AND NOT EXISTS (SELECT 1 FROM asset_grants g WHERE g.asset_id=assets.asset_id)
             AND NOT EXISTS (SELECT 1 FROM asset_downloads d WHERE d.asset_id=assets.asset_id)"#,
    )
    .bind(&asset_id)
    .execute(&mut *transaction)
    .await
    .map_err(|error| format!("无法删除资产元数据: {error}"))?
    .rows_affected();
    if deleted == 0 {
        transaction
            .rollback()
            .await
            .map_err(|error| format!("无法回滚资产删除事务: {error}"))?;
        return Err("资产仍被模组、房间或公开授权引用".to_string());
    }
    transaction
        .commit()
        .await
        .map_err(|error| format!("无法提交资产删除事务: {error}"))?;

    let path = managed_asset_path(&app, &asset_id, &storage_key, false)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(format!("资产元数据已删除，但无法清理托管文件: {error}")),
    }
}

/// Returns only a canonical path inside this application's managed asset root.
/// Source paths selected by the user are never retained or returned.
#[tauri::command]
pub(crate) async fn resolve_asset_path(
    app: tauri::AppHandle,
    databases: State<'_, DbInstances>,
    asset_id: String,
) -> Result<String, String> {
    let pool = database_pool(&databases).await?;
    let storage_key = asset_storage_key(&pool, &asset_id).await?;
    let path = managed_asset_path(&app, &asset_id, &storage_key, true)?;
    path.to_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| "当前版本不支持非 Unicode 的内部资产路径".to_string())
}

#[tauri::command]
pub(crate) async fn read_asset_chunk(
    app: tauri::AppHandle,
    databases: State<'_, DbInstances>,
    asset_id: String,
    offset: u64,
    length: usize,
) -> Result<AssetChunkRead, String> {
    if length == 0 || length > MAX_ASSET_CHUNK_BYTES {
        return Err(format!(
            "单次资产读取必须在 1 到 {MAX_ASSET_CHUNK_BYTES} 字节之间"
        ));
    }
    let pool = database_pool(&databases).await?;
    let row = sqlx::query("SELECT storage_key, byte_length FROM assets WHERE asset_id=?")
        .bind(&asset_id)
        .fetch_optional(&pool)
        .await
        .map_err(|error| format!("无法查询资产: {error}"))?
        .ok_or_else(|| "本机没有该资产".to_string())?;
    let storage_key: String = row.get("storage_key");
    let expected_length: i64 = row.get("byte_length");
    let expected_length =
        u64::try_from(expected_length).map_err(|_| "资产元数据中的长度无效".to_string())?;
    if offset > expected_length {
        return Err("资产读取偏移超出文件范围".to_string());
    }
    let path = managed_asset_path(&app, &asset_id, &storage_key, true)?;
    let mut file = File::open(&path).map_err(|error| format!("无法打开托管资产: {error}"))?;
    let actual_length = file
        .metadata()
        .map_err(|error| format!("无法读取托管资产信息: {error}"))?
        .len();
    if actual_length != expected_length {
        return Err("托管资产长度与数据库记录不一致".to_string());
    }
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("无法定位资产分块: {error}"))?;
    let remaining = expected_length.saturating_sub(offset);
    let read_length = remaining.min(length as u64) as usize;
    let mut data = vec![0_u8; read_length];
    file.read_exact(&mut data)
        .map_err(|error| format!("无法读取资产分块: {error}"))?;
    Ok(AssetChunkRead {
        asset_id,
        offset,
        eof: offset + read_length as u64 == expected_length,
        data,
    })
}

#[tauri::command]
pub(crate) async fn verify_managed_asset(
    app: tauri::AppHandle,
    databases: State<'_, DbInstances>,
    asset_id: String,
) -> Result<AssetDescriptor, String> {
    let pool = database_pool(&databases).await?;
    let row = sqlx::query("SELECT storage_key, byte_length FROM assets WHERE asset_id=?")
        .bind(&asset_id)
        .fetch_optional(&pool)
        .await
        .map_err(|error| format!("无法查询资产: {error}"))?
        .ok_or_else(|| "本机没有该资产".to_string())?;
    let storage_key: String = row.get("storage_key");
    let expected_length: i64 = row.get("byte_length");
    let expected_length =
        u64::try_from(expected_length).map_err(|_| "资产元数据中的长度无效".to_string())?;
    let path = managed_asset_path(&app, &asset_id, &storage_key, true)?;
    verify_file_hash(&path, &asset_id, expected_length)?;
    sqlx::query(
        "UPDATE assets SET last_verified_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE asset_id=?",
    )
    .bind(&asset_id)
    .execute(&pool)
    .await
    .map_err(|error| format!("无法更新资产校验时间: {error}"))?;
    let row = sqlx::query(
        r#"SELECT asset_id, media_kind, media_type, byte_length,
                  pixel_width, pixel_height, created_at, last_verified_at
           FROM assets WHERE asset_id=?"#,
    )
    .bind(&asset_id)
    .fetch_one(&pool)
    .await
    .map_err(|error| format!("无法读取已校验资产: {error}"))?;
    descriptor_from_row(&row)
}

async fn import_prepared_asset<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    databases: &DbInstances,
    prepared: PreparedAsset,
) -> Result<AssetImportResult, String> {
    let root = initialize_asset_store(app)?;
    let temp_root = asset_temp_root(app)?;
    let persisted = persist_prepared_asset(&root, &temp_root, prepared)?;
    let pool = database_pool(databases).await?;
    let descriptor = register_asset(&pool, &persisted).await?;
    Ok(AssetImportResult {
        asset: descriptor,
        deduplicated: persisted.deduplicated,
    })
}

async fn database_pool(databases: &DbInstances) -> Result<Pool<Sqlite>, String> {
    let instances = databases.0.read().await;
    match instances.get(DATABASE_URL) {
        Some(DbPool::Sqlite(pool)) => Ok(pool.clone()),
        None => Err("本地数据库尚未初始化".to_string()),
    }
}

async fn register_asset(
    pool: &Pool<Sqlite>,
    persisted: &PersistedAsset,
) -> Result<AssetDescriptor, String> {
    let asset = &persisted.descriptor;
    sqlx::query(
        r#"INSERT INTO assets (
             asset_id, media_kind, media_type, byte_length, pixel_width,
             pixel_height, storage_key, created_at, last_verified_at
           ) VALUES (
             ?, ?, ?, ?, ?, ?, ?,
             strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             strftime('%Y-%m-%dT%H:%M:%fZ','now')
           ) ON CONFLICT(asset_id) DO NOTHING"#,
    )
    .bind(&asset.asset_id)
    .bind(asset.media_kind.as_str())
    .bind(&asset.media_type)
    .bind(asset.byte_length as i64)
    .bind(asset.width.map(i64::from))
    .bind(asset.height.map(i64::from))
    .bind(&persisted.storage_key)
    .execute(pool)
    .await
    .map_err(|error| format!("无法保存资产元数据: {error}"))?;

    let row = sqlx::query(
        "SELECT media_kind, media_type, byte_length, pixel_width, pixel_height, storage_key FROM assets WHERE asset_id=?",
    )
    .bind(&asset.asset_id)
    .fetch_one(pool)
    .await
    .map_err(|error| format!("无法核对资产元数据: {error}"))?;
    let matches = row.get::<String, _>("media_kind") == asset.media_kind.as_str()
        && row.get::<String, _>("media_type") == asset.media_type
        && row.get::<i64, _>("byte_length") == asset.byte_length as i64
        && row.get::<Option<i64>, _>("pixel_width") == asset.width.map(i64::from)
        && row.get::<Option<i64>, _>("pixel_height") == asset.height.map(i64::from)
        && row.get::<String, _>("storage_key") == persisted.storage_key;
    if !matches {
        return Err("同一资产哈希对应了冲突的本地元数据".to_string());
    }
    sqlx::query(
        "UPDATE assets SET last_verified_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE asset_id=?",
    )
    .bind(&asset.asset_id)
    .execute(pool)
    .await
    .map_err(|error| format!("无法更新资产校验时间: {error}"))?;
    let row = sqlx::query(
        r#"SELECT asset_id, media_kind, media_type, byte_length,
                  pixel_width, pixel_height, created_at, last_verified_at
           FROM assets WHERE asset_id=?"#,
    )
    .bind(&asset.asset_id)
    .fetch_one(pool)
    .await
    .map_err(|error| format!("无法读取已保存资产: {error}"))?;
    descriptor_from_row(&row)
}

fn read_bounded_source(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    let canonical = path
        .canonicalize()
        .map_err(|_| "无法读取所选媒体文件".to_string())?;
    let mut file = File::open(&canonical).map_err(|_| "无法打开所选媒体文件".to_string())?;
    let metadata = file
        .metadata()
        .map_err(|_| "无法读取所选媒体文件信息".to_string())?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > limit as u64 {
        return Err(format!("媒体文件必须是 1 到 {limit} 字节的普通文件"));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    Read::by_ref(&mut file)
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取所选媒体文件".to_string())?;
    if bytes.len() > limit {
        return Err(format!("媒体文件超过 {limit} 字节限制"));
    }
    Ok(bytes)
}

fn prepare_asset(
    kind: AssetMediaKind,
    bytes: Vec<u8>,
    declared_media_type: Option<&str>,
) -> Result<PreparedAsset, String> {
    if bytes.is_empty() || bytes.len() > kind.source_limit() {
        return Err(asset_size_error(kind));
    }
    match kind {
        AssetMediaKind::Image => prepare_image(bytes, declared_media_type),
        AssetMediaKind::Audio => prepare_audio(bytes, declared_media_type),
    }
}

fn prepare_received_asset(
    descriptor: &ReceivedAssetDescriptor,
    bytes: Vec<u8>,
) -> Result<PreparedAsset, String> {
    if descriptor.schema_version != 1 {
        return Err("只支持 AssetDescriptorV1".to_string());
    }
    validate_asset_id(&descriptor.asset_id)?;
    if bytes.is_empty() || bytes.len() > MAX_AUDIO_ASSET_BYTES {
        return Err("接收资产必须在 1 字节到 64 MiB 之间".to_string());
    }
    if descriptor.byte_length != bytes.len() as u64 {
        return Err("接收资产长度与描述符不一致".to_string());
    }
    if asset_id_for_bytes(&bytes) != descriptor.asset_id {
        return Err("接收资产未通过 SHA-256 校验".to_string());
    }
    if descriptor
        .duration_ms
        .is_some_and(|duration| duration > 24 * 60 * 60 * 1_000)
    {
        return Err("接收资产时长元数据超出 24 小时".to_string());
    }

    match descriptor.media_type.as_str() {
        "image/webp" => {
            if bytes.len() > MAX_IMAGE_ASSET_BYTES || descriptor.duration_ms.is_some() {
                return Err("接收图片的大小或时长字段无效".to_string());
            }
            let (expected_width, expected_height) = match (descriptor.width, descriptor.height) {
                (Some(width), Some(height)) => (width, height),
                _ => return Err("接收图片描述符必须同时提供宽度和高度".to_string()),
            };
            validate_image_dimensions(expected_width, expected_height)?;
            validate_received_static_webp(&bytes)?;
            let reader = ImageReader::with_format(Cursor::new(&bytes), ImageFormat::WebP);
            let (actual_width, actual_height) = reader
                .into_dimensions()
                .map_err(|_| "无法读取接收 WebP 的尺寸".to_string())?;
            if (actual_width, actual_height) != (expected_width, expected_height) {
                return Err("接收 WebP 的实际尺寸与描述符不一致".to_string());
            }
            image::load_from_memory_with_format(&bytes, ImageFormat::WebP)
                .map_err(|_| "接收 WebP 损坏或无法安全解码".to_string())?;
            Ok(PreparedAsset {
                bytes,
                media_kind: AssetMediaKind::Image,
                media_type: "image/webp",
                extension: "webp",
                pixel_width: Some(actual_width),
                pixel_height: Some(actual_height),
            })
        }
        "audio/mpeg" | "audio/ogg" | "audio/wav" => {
            if descriptor.width.is_some() || descriptor.height.is_some() {
                return Err("接收音频描述符不能包含图片尺寸".to_string());
            }
            let (detected_media_type, extension) = detect_audio_format(&bytes)?;
            if detected_media_type != descriptor.media_type {
                return Err("接收音频的媒体类型与内容不一致".to_string());
            }
            Ok(PreparedAsset {
                bytes,
                media_kind: AssetMediaKind::Audio,
                media_type: detected_media_type,
                extension,
                pixel_width: None,
                pixel_height: None,
            })
        }
        _ => Err("接收资产只支持静态 WebP、MP3、Ogg 或 WAV".to_string()),
    }
}

fn prepare_image(
    bytes: Vec<u8>,
    declared_media_type: Option<&str>,
) -> Result<PreparedAsset, String> {
    if looks_like_svg(&bytes) {
        return Err("不支持 SVG；请选择静态 PNG、JPEG 或 WebP".to_string());
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Err("不支持 GIF 或动画图片".to_string());
    }
    let format = image::guess_format(&bytes).map_err(|_| "无法识别图片格式".to_string())?;
    let source_media_type = match format {
        ImageFormat::Png => {
            reject_animated_png(&bytes)?;
            "image/png"
        }
        ImageFormat::Jpeg => "image/jpeg",
        ImageFormat::WebP => {
            reject_animated_webp(&bytes)?;
            "image/webp"
        }
        ImageFormat::Gif => return Err("不支持 GIF 或动画图片".to_string()),
        _ => return Err("只支持静态 PNG、JPEG 或 WebP".to_string()),
    };
    require_matching_media_type(declared_media_type, source_media_type)?;

    let reader = ImageReader::with_format(Cursor::new(&bytes), format);
    let (width, height) = reader
        .into_dimensions()
        .map_err(|_| "无法读取图片尺寸".to_string())?;
    validate_image_dimensions(width, height)?;
    let decoded = image::load_from_memory_with_format(&bytes, format)
        .map_err(|_| "图片数据损坏或无法安全解码".to_string())?;
    let (encoded, output_width, output_height) = encode_bounded_static_webp(decoded)?;
    Ok(PreparedAsset {
        bytes: encoded,
        media_kind: AssetMediaKind::Image,
        media_type: "image/webp",
        extension: "webp",
        pixel_width: Some(output_width),
        pixel_height: Some(output_height),
    })
}

fn prepare_audio(
    bytes: Vec<u8>,
    declared_media_type: Option<&str>,
) -> Result<PreparedAsset, String> {
    let (media_type, extension) = detect_audio_format(&bytes)?;
    require_matching_media_type(declared_media_type, media_type)?;
    Ok(PreparedAsset {
        bytes,
        media_kind: AssetMediaKind::Audio,
        media_type,
        extension,
        pixel_width: None,
        pixel_height: None,
    })
}

fn persist_prepared_asset(
    root: &Path,
    temp_root: &Path,
    asset: PreparedAsset,
) -> Result<PersistedAsset, String> {
    fs::create_dir_all(root).map_err(|error| format!("无法创建资产根目录: {error}"))?;
    fs::create_dir_all(temp_root).map_err(|error| format!("无法创建资产临时目录: {error}"))?;
    let asset_id = asset_id_for_bytes(&asset.bytes);
    let hash = asset_id
        .strip_prefix("sha256:")
        .ok_or_else(|| "内部资产哈希无效".to_string())?;
    let storage_key = format!("{}/{}.{}", &hash[..2], hash, asset.extension);
    validate_storage_key(&asset_id, &storage_key)?;
    let directory = root.join(&hash[..2]);
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建资产分片目录: {error}"))?;
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("无法确认资产根目录: {error}"))?;
    let canonical_base = root
        .parent()
        .ok_or_else(|| "资产根目录缺少父目录".to_string())?
        .canonicalize()
        .map_err(|error| format!("无法确认资产基目录: {error}"))?;
    let canonical_temp_root = temp_root
        .canonicalize()
        .map_err(|error| format!("无法确认资产临时目录: {error}"))?;
    if !canonical_root.starts_with(&canonical_base)
        || !canonical_temp_root.starts_with(&canonical_base)
    {
        return Err("资产目录逃逸了应用托管范围".to_string());
    }
    let canonical_directory = directory
        .canonicalize()
        .map_err(|error| format!("无法确认资产分片目录: {error}"))?;
    if !canonical_directory.starts_with(&canonical_root) {
        return Err("资产分片目录逃逸了应用托管范围".to_string());
    }
    let target = canonical_directory.join(format!("{hash}.{}", asset.extension));
    if target.exists() {
        let canonical_target = target
            .canonicalize()
            .map_err(|error| format!("无法确认现有资产路径: {error}"))?;
        if !canonical_target.starts_with(&canonical_root) || !canonical_target.is_file() {
            return Err("现有资产路径逃逸了应用托管范围".to_string());
        }
        verify_file_hash(&canonical_target, &asset_id, asset.bytes.len() as u64)?;
        return Ok(persisted_descriptor(asset, asset_id, storage_key, true));
    }

    let mut temporary = NamedTempFile::new_in(canonical_temp_root)
        .map_err(|error| format!("无法创建资产临时文件: {error}"))?;
    temporary
        .write_all(&asset.bytes)
        .and_then(|()| temporary.as_file().sync_all())
        .map_err(|error| format!("无法写入资产临时文件: {error}"))?;
    match temporary.persist_noclobber(&target) {
        Ok(_) => Ok(persisted_descriptor(asset, asset_id, storage_key, false)),
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
            verify_file_hash(&target, &asset_id, asset.bytes.len() as u64)?;
            Ok(persisted_descriptor(asset, asset_id, storage_key, true))
        }
        Err(error) => Err(format!("无法原子保存内容寻址资产: {}", error.error)),
    }
}

fn persisted_descriptor(
    asset: PreparedAsset,
    asset_id: String,
    storage_key: String,
    deduplicated: bool,
) -> PersistedAsset {
    PersistedAsset {
        descriptor: AssetDescriptor {
            schema_version: 1,
            asset_id,
            media_kind: asset.media_kind,
            media_type: asset.media_type.to_string(),
            byte_length: asset.bytes.len() as u64,
            width: asset.pixel_width,
            height: asset.pixel_height,
        },
        storage_key,
        deduplicated,
    }
}

fn encode_bounded_static_webp(mut image: DynamicImage) -> Result<(Vec<u8>, u32, u32), String> {
    for _ in 0..16 {
        let (width, height) = image.dimensions();
        let rgba = image.to_rgba8();
        let mut encoded = Vec::new();
        WebPEncoder::new_lossless(&mut encoded)
            .write_image(&rgba, width, height, image::ExtendedColorType::Rgba8)
            .map_err(|_| "无法把图片规范化为静态 WebP".to_string())?;
        if encoded.len() <= MAX_IMAGE_ASSET_BYTES {
            return Ok((encoded, width, height));
        }
        if width == 1 && height == 1 {
            break;
        }
        let ratio = (MAX_IMAGE_ASSET_BYTES as f64 / encoded.len() as f64).sqrt() * 0.92;
        let ratio = ratio.clamp(0.25, 0.9);
        let next_width =
            ((width as f64 * ratio).floor() as u32).clamp(1, width.saturating_sub(1).max(1));
        let next_height =
            ((height as f64 * ratio).floor() as u32).clamp(1, height.saturating_sub(1).max(1));
        image = image.resize_exact(next_width, next_height, FilterType::Lanczos3);
    }
    Err("图片规范化后仍超过 8 MiB".to_string())
}

fn validate_image_dimensions(width: u32, height: u32) -> Result<(), String> {
    let pixels = u64::from(width) * u64::from(height);
    if width == 0
        || height == 0
        || width > MAX_IMAGE_EDGE
        || height > MAX_IMAGE_EDGE
        || pixels > MAX_IMAGE_PIXELS
    {
        return Err("图片尺寸不得超过单边 8192 像素和总计 3200 万像素".to_string());
    }
    Ok(())
}

fn reject_animated_png(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < 8 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
        return Err("PNG 文件头无效".to_string());
    }
    let mut offset = 8_usize;
    while offset.checked_add(12).is_some_and(|end| end <= bytes.len()) {
        let length = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        let chunk_type = &bytes[offset + 4..offset + 8];
        if chunk_type == b"acTL" || chunk_type == b"fcTL" || chunk_type == b"fdAT" {
            return Err("不支持动画 PNG".to_string());
        }
        let next = offset
            .checked_add(12)
            .and_then(|value| value.checked_add(length))
            .ok_or_else(|| "PNG 分块长度无效".to_string())?;
        if next > bytes.len() {
            return Err("PNG 分块不完整".to_string());
        }
        offset = next;
        if chunk_type == b"IEND" {
            return Ok(());
        }
    }
    Err("PNG 缺少完整的结束分块".to_string())
}

fn reject_animated_webp(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < 12 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return Err("WebP 文件头无效".to_string());
    }
    let mut offset = 12_usize;
    while offset.checked_add(8).is_some_and(|end| end <= bytes.len()) {
        let chunk_type = &bytes[offset..offset + 4];
        let length = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let data_start = offset + 8;
        let data_end = data_start
            .checked_add(length)
            .ok_or_else(|| "WebP 分块长度无效".to_string())?;
        if data_end > bytes.len() {
            return Err("WebP 分块不完整".to_string());
        }
        if chunk_type == b"ANIM" || chunk_type == b"ANMF" {
            return Err("不支持动画 WebP".to_string());
        }
        if chunk_type == b"VP8X" && length >= 1 && bytes[data_start] & 0x02 != 0 {
            return Err("不支持动画 WebP".to_string());
        }
        offset = match data_end.checked_add(length & 1) {
            Some(value) if value <= bytes.len() => value,
            _ => return Err("WebP 分块填充不完整".to_string()),
        };
    }
    Ok(())
}

fn validate_received_static_webp(bytes: &[u8]) -> Result<(), String> {
    reject_animated_webp(bytes)?;
    let declared_length = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
    if declared_length
        .checked_add(8)
        .is_none_or(|length| length != bytes.len())
    {
        return Err("接收 WebP 的 RIFF 长度无效".to_string());
    }
    let mut offset = 12_usize;
    let mut has_pixels = false;
    while offset.checked_add(8).is_some_and(|end| end <= bytes.len()) {
        let chunk_type = &bytes[offset..offset + 4];
        let length = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let data_start = offset + 8;
        let data_end = data_start
            .checked_add(length)
            .ok_or_else(|| "接收 WebP 分块长度无效".to_string())?;
        if data_end > bytes.len() {
            return Err("接收 WebP 分块不完整".to_string());
        }
        if matches!(chunk_type, b"EXIF" | b"XMP " | b"ICCP") {
            return Err("接收 WebP 含有未剥离的元数据".to_string());
        }
        if chunk_type == b"VP8X" && length >= 1 && bytes[data_start] & 0x2c != 0 {
            return Err("接收 WebP 含动画或元数据扩展".to_string());
        }
        if matches!(chunk_type, b"VP8 " | b"VP8L") {
            has_pixels = true;
        }
        offset = data_end
            .checked_add(length & 1)
            .filter(|next| *next <= bytes.len())
            .ok_or_else(|| "接收 WebP 分块填充不完整".to_string())?;
    }
    if offset != bytes.len() || !has_pixels {
        return Err("接收 WebP 缺少完整的静态像素分块".to_string());
    }
    Ok(())
}

fn detect_audio_format(bytes: &[u8]) -> Result<(&'static str, &'static str), String> {
    if is_valid_wav(bytes) {
        return Ok(("audio/wav", "wav"));
    }
    if is_valid_ogg_audio(bytes) {
        return Ok(("audio/ogg", "ogg"));
    }
    if is_valid_mp3(bytes) {
        return Ok(("audio/mpeg", "mp3"));
    }
    Err("只支持可验证的 MP3、Ogg Vorbis/Opus 或 WAV 音频".to_string())
}

fn is_valid_wav(bytes: &[u8]) -> bool {
    if bytes.len() < 12 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return false;
    }
    let declared = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
    let Some(container_end) = declared.checked_add(8) else {
        return false;
    };
    if container_end < 12 || container_end > bytes.len() {
        return false;
    }
    let mut offset = 12_usize;
    let mut has_format = false;
    let mut has_data = false;
    while offset
        .checked_add(8)
        .is_some_and(|end| end <= container_end)
    {
        let chunk_type = &bytes[offset..offset + 4];
        let length = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let data_start = offset + 8;
        let data_end = match data_start.checked_add(length) {
            Some(value) if value <= container_end => value,
            _ => return false,
        };
        if chunk_type == b"fmt " {
            if length < 16 {
                return false;
            }
            let channels =
                u16::from_le_bytes(bytes[data_start + 2..data_start + 4].try_into().unwrap());
            let sample_rate =
                u32::from_le_bytes(bytes[data_start + 4..data_start + 8].try_into().unwrap());
            let block_align =
                u16::from_le_bytes(bytes[data_start + 12..data_start + 14].try_into().unwrap());
            if channels == 0 || sample_rate == 0 || block_align == 0 {
                return false;
            }
            has_format = true;
        } else if chunk_type == b"data" {
            has_data = length > 0;
        }
        offset = match data_end.checked_add(length & 1) {
            Some(value) if value <= container_end => value,
            _ => return false,
        };
    }
    has_format && has_data
}

fn is_valid_ogg_audio(bytes: &[u8]) -> bool {
    if bytes.len() < 27 || &bytes[..4] != b"OggS" || bytes[4] != 0 || bytes[5] & 0x02 == 0 {
        return false;
    }
    let segment_count = bytes[26] as usize;
    if 27 + segment_count > bytes.len() {
        return false;
    }
    let segment_table = &bytes[27..27 + segment_count];
    let Some(total_payload_length) = segment_table.iter().try_fold(0_usize, |length, segment| {
        length.checked_add(*segment as usize)
    }) else {
        return false;
    };
    let payload_start = 27 + segment_count;
    if payload_start
        .checked_add(total_payload_length)
        .is_none_or(|end| end > bytes.len())
    {
        return false;
    }
    let mut first_packet_length = 0_usize;
    let mut packet_complete = false;
    for segment in segment_table {
        first_packet_length = match first_packet_length.checked_add(*segment as usize) {
            Some(length) => length,
            None => return false,
        };
        if *segment < 255 {
            packet_complete = true;
            break;
        }
    }
    let payload_end = match payload_start.checked_add(first_packet_length) {
        Some(end) if end <= bytes.len() && packet_complete => end,
        _ => return false,
    };
    let identification = &bytes[payload_start..payload_end];
    identification.starts_with(b"OpusHead") || identification.starts_with(b"\x01vorbis")
}

fn is_valid_mp3(bytes: &[u8]) -> bool {
    if bytes.len() < 4 {
        return false;
    }
    let mut start = 0_usize;
    if bytes.len() >= 10 && &bytes[..3] == b"ID3" {
        let size_bytes = &bytes[6..10];
        if size_bytes.iter().any(|byte| byte & 0x80 != 0) {
            return false;
        }
        let tag_size = size_bytes
            .iter()
            .fold(0_usize, |value, byte| (value << 7) | *byte as usize);
        start = match 10_usize.checked_add(tag_size) {
            Some(value) if value < bytes.len() => value,
            _ => return false,
        };
        if bytes[5] & 0x10 != 0 {
            start = match start.checked_add(10) {
                Some(value) if value < bytes.len() => value,
                _ => return false,
            };
        }
    }
    let scan_end = bytes
        .len()
        .saturating_sub(4)
        .min(start.saturating_add(MAX_AUDIO_PROBE_BYTES));
    for offset in start..=scan_end {
        let Some(frame_length) = mp3_frame_length(&bytes[offset..offset + 4]) else {
            continue;
        };
        let Some(next_offset) = offset.checked_add(frame_length) else {
            continue;
        };
        if next_offset > bytes.len() {
            continue;
        }
        if next_offset == bytes.len()
            || (bytes.len() - next_offset == 128 && bytes[next_offset..].starts_with(b"TAG"))
        {
            return true;
        }
        if next_offset + 4 <= bytes.len()
            && mp3_frame_length(&bytes[next_offset..next_offset + 4]).is_some()
        {
            return true;
        }
    }
    false
}

fn mp3_frame_length(header: &[u8]) -> Option<usize> {
    if header.len() != 4 || header[0] != 0xff || header[1] & 0xe0 != 0xe0 {
        return None;
    }
    let version = (header[1] >> 3) & 0x03;
    let layer = (header[1] >> 1) & 0x03;
    let bitrate_index = (header[2] >> 4) as usize;
    let sample_rate_index = ((header[2] >> 2) & 0x03) as usize;
    if version == 0x01
        || layer == 0x00
        || bitrate_index == 0
        || bitrate_index == 0x0f
        || sample_rate_index == 0x03
    {
        return None;
    }

    const MPEG1_LAYER1: [u16; 15] = [
        0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448,
    ];
    const MPEG1_LAYER2: [u16; 15] = [
        0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384,
    ];
    const MPEG1_LAYER3: [u16; 15] = [
        0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
    ];
    const MPEG2_LAYER1: [u16; 15] = [
        0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256,
    ];
    const MPEG2_LAYER23: [u16; 15] = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    let bitrate_kbps = match (version, layer) {
        (0x03, 0x03) => MPEG1_LAYER1[bitrate_index],
        (0x03, 0x02) => MPEG1_LAYER2[bitrate_index],
        (0x03, 0x01) => MPEG1_LAYER3[bitrate_index],
        (_, 0x03) => MPEG2_LAYER1[bitrate_index],
        _ => MPEG2_LAYER23[bitrate_index],
    } as usize;
    let base_sample_rate = [44_100_usize, 48_000, 32_000][sample_rate_index];
    let sample_rate = match version {
        0x03 => base_sample_rate,
        0x02 => base_sample_rate / 2,
        0x00 => base_sample_rate / 4,
        _ => return None,
    };
    let padding = ((header[2] >> 1) & 1) as usize;
    let bitrate = bitrate_kbps.checked_mul(1_000)?;
    match layer {
        0x03 => 12_usize
            .checked_mul(bitrate)?
            .checked_div(sample_rate)?
            .checked_add(padding)?
            .checked_mul(4),
        0x01 if version != 0x03 => 72_usize
            .checked_mul(bitrate)?
            .checked_div(sample_rate)?
            .checked_add(padding),
        _ => 144_usize
            .checked_mul(bitrate)?
            .checked_div(sample_rate)?
            .checked_add(padding),
    }
}

fn looks_like_svg(bytes: &[u8]) -> bool {
    let prefix = String::from_utf8_lossy(&bytes[..bytes.len().min(4_096)]).to_ascii_lowercase();
    prefix.contains("<svg")
}

fn require_matching_media_type(declared: Option<&str>, detected: &str) -> Result<(), String> {
    if let Some(declared) = declared {
        if declared != detected {
            return Err("声明的媒体类型与文件内容不一致".to_string());
        }
    }
    Ok(())
}

fn asset_size_error(kind: AssetMediaKind) -> String {
    match kind {
        AssetMediaKind::Image => "图片输入必须在 1 字节到 25 MiB 之间".to_string(),
        AssetMediaKind::Audio => "音频输入必须在 1 字节到 64 MiB 之间".to_string(),
    }
}

fn asset_id_for_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!("sha256:{}", lowercase_hex(&digest))
}

fn lowercase_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn validate_asset_id(asset_id: &str) -> Result<&str, String> {
    let hash = asset_id
        .strip_prefix("sha256:")
        .ok_or_else(|| "资产 ID 必须使用 sha256 内容地址".to_string())?;
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("资产 ID 包含无效的 SHA-256".to_string());
    }
    Ok(hash)
}

fn validate_asset_reference_input(
    asset_id: &str,
    owner_type: &str,
    owner_id: &str,
    owner_revision: i64,
    slot: &str,
) -> Result<(), String> {
    validate_asset_id(asset_id)?;
    if !ASSET_OWNER_TYPES.contains(&owner_type) {
        return Err("资产引用的所有者类型不受支持".to_string());
    }
    validate_reference_identifier(owner_id, 240, "资产引用所有者 ID")?;
    if !(0..=MAX_OWNER_REVISION).contains(&owner_revision) {
        return Err(format!("资产引用版本必须在 0 到 {MAX_OWNER_REVISION} 之间"));
    }
    validate_reference_identifier(slot, 120, "资产引用槽位")
}

fn asset_download_gate() -> &'static tokio::sync::Mutex<()> {
    static GATE: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    GATE.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn validate_download_identity(
    room_id: &str,
    peer_id: &str,
    transfer_id: &str,
) -> Result<(), String> {
    validate_reference_identifier(room_id, 240, "room ID")?;
    validate_reference_identifier(peer_id, 64, "source peer ID")?;
    if peer_id.len() < 8 {
        return Err("source peer ID must contain at least 8 bytes".to_string());
    }
    validate_reference_identifier(transfer_id, 128, "transfer ID")
}

fn validate_received_descriptor_metadata(asset: &ReceivedAssetDescriptor) -> Result<(), String> {
    if asset.schema_version != 1 {
        return Err("Only AssetDescriptorV1 can be transferred".to_string());
    }
    validate_asset_id(&asset.asset_id)?;
    if asset.byte_length == 0 || asset.byte_length > MAX_AUDIO_ASSET_BYTES as u64 {
        return Err("Transferred asset size must be between 1 byte and 64 MiB".to_string());
    }
    if asset
        .duration_ms
        .is_some_and(|duration| duration > 24 * 60 * 60 * 1_000)
    {
        return Err("Transferred asset duration exceeds 24 hours".to_string());
    }
    match asset.media_type.as_str() {
        "image/webp" => {
            if asset.byte_length > MAX_IMAGE_ASSET_BYTES as u64 || asset.duration_ms.is_some() {
                return Err("Transferred image metadata is invalid".to_string());
            }
            let (Some(width), Some(height)) = (asset.width, asset.height) else {
                return Err("Transferred image must include dimensions".to_string());
            };
            validate_image_dimensions(width, height)
        }
        "audio/mpeg" | "audio/ogg" | "audio/wav" => {
            if asset.width.is_some() || asset.height.is_some() {
                return Err("Transferred audio cannot include image dimensions".to_string());
            }
            Ok(())
        }
        _ => Err("Transferred asset MIME type is not supported".to_string()),
    }
}

fn room_asset_chunk_count(byte_length: u64) -> Result<u32, String> {
    let count = byte_length.div_ceil(ROOM_ASSET_CHUNK_BYTES as u64);
    u32::try_from(count)
        .ok()
        .filter(|value| (1..=16_384).contains(value))
        .ok_or_else(|| "Transferred asset chunk count is invalid".to_string())
}

fn room_asset_chunk_length(
    byte_length: u64,
    chunk_index: u32,
    chunk_count: u32,
) -> Result<usize, String> {
    if chunk_index >= chunk_count || chunk_count != room_asset_chunk_count(byte_length)? {
        return Err("Transferred asset chunk coordinates are invalid".to_string());
    }
    let offset = u64::from(chunk_index) * ROOM_ASSET_CHUNK_BYTES as u64;
    Ok(byte_length
        .saturating_sub(offset)
        .min(ROOM_ASSET_CHUNK_BYTES as u64) as usize)
}

fn download_storage_key(room_id: &str, asset_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(room_id.as_bytes());
    hasher.update([0]);
    hasher.update(asset_id.as_bytes());
    format!("download-{}.part", lowercase_hex(&hasher.finalize()))
}

fn validate_download_storage_key(storage_key: &str) -> Result<(), String> {
    let Some(hash) = storage_key
        .strip_prefix("download-")
        .and_then(|value| value.strip_suffix(".part"))
    else {
        return Err("Partial asset storage key is invalid".to_string());
    };
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err("Partial asset storage key is invalid".to_string());
    }
    Ok(())
}

fn validate_reference_identifier(value: &str, maximum: usize, label: &str) -> Result<(), String> {
    let bytes = value.as_bytes();
    if bytes.is_empty()
        || bytes.len() > maximum
        || !bytes[0].is_ascii_alphanumeric()
        || !bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'.' | b'_' | b':' | b'-'))
    {
        return Err(format!(
            "{label} 必须是 1 到 {maximum} 字节的 URL 安全标识符"
        ));
    }
    Ok(())
}

fn validate_storage_key(asset_id: &str, storage_key: &str) -> Result<(), String> {
    let hash = validate_asset_id(asset_id)?;
    let path = Path::new(storage_key);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("资产存储键不是安全的相对路径".to_string());
    }
    let components: Vec<_> = path.components().collect();
    if components.len() != 2 {
        return Err("资产存储键层级无效".to_string());
    }
    let shard = components[0].as_os_str().to_string_lossy();
    let file_name = components[1].as_os_str().to_string_lossy();
    let expected_prefix = format!("{hash}.");
    if shard != &hash[..2]
        || !file_name.starts_with(&expected_prefix)
        || !matches!(
            file_name.rsplit_once('.').map(|(_, ext)| ext),
            Some("webp" | "mp3" | "ogg" | "wav")
        )
    {
        return Err("资产存储键与内容哈希不一致".to_string());
    }
    Ok(())
}

fn verify_file_hash(path: &Path, asset_id: &str, expected_length: u64) -> Result<(), String> {
    let mut file = File::open(path).map_err(|error| format!("无法打开托管资产: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("无法读取托管资产信息: {error}"))?;
    if !metadata.is_file() || metadata.len() != expected_length {
        return Err("托管资产长度与内容地址不一致".to_string());
    }
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("无法校验托管资产: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let actual = format!("sha256:{}", lowercase_hex(&hasher.finalize()));
    if actual != asset_id {
        return Err("托管资产未通过 SHA-256 校验".to_string());
    }
    Ok(())
}

async fn asset_storage_key(pool: &Pool<Sqlite>, asset_id: &str) -> Result<String, String> {
    validate_asset_id(asset_id)?;
    sqlx::query_scalar("SELECT storage_key FROM assets WHERE asset_id=?")
        .bind(asset_id)
        .fetch_optional(pool)
        .await
        .map_err(|error| format!("无法查询资产: {error}"))?
        .ok_or_else(|| "本机没有该资产".to_string())
}

fn asset_root<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    Ok(asset_base(app)?.join(HASH_DIRECTORY))
}

fn asset_temp_root<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    Ok(asset_base(app)?.join(TEMP_DIRECTORY))
}

fn managed_download_path<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    storage_key: &str,
    must_exist: bool,
) -> Result<PathBuf, String> {
    validate_download_storage_key(storage_key)?;
    let root = asset_temp_root(app)?;
    fs::create_dir_all(&root)
        .map_err(|error| format!("Unable to create partial asset directory: {error}"))?;
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("Unable to validate partial asset directory: {error}"))?;
    let candidate = canonical_root.join(storage_key);
    if !must_exist {
        return Ok(candidate);
    }
    let canonical = candidate
        .canonicalize()
        .map_err(|_| "Partial asset file does not exist".to_string())?;
    if !canonical.starts_with(&canonical_root) || !canonical.is_file() {
        return Err("Partial asset path escaped the managed directory".to_string());
    }
    Ok(canonical)
}

fn asset_base<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?
        .join(ASSET_DIRECTORY))
}

fn managed_asset_path<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    asset_id: &str,
    storage_key: &str,
    must_exist: bool,
) -> Result<PathBuf, String> {
    validate_storage_key(asset_id, storage_key)?;
    let root = asset_root(app)?;
    fs::create_dir_all(&root).map_err(|error| format!("无法创建资产根目录: {error}"))?;
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("无法确认资产根目录: {error}"))?;
    let candidate = canonical_root.join(storage_key);
    if must_exist {
        let canonical = candidate
            .canonicalize()
            .map_err(|_| "托管资产文件不存在".to_string())?;
        if !canonical.starts_with(&canonical_root) || !canonical.is_file() {
            return Err("资产路径逃逸了应用托管范围".to_string());
        }
        Ok(canonical)
    } else {
        let parent = candidate
            .parent()
            .ok_or_else(|| "资产存储键没有父目录".to_string())?;
        fs::create_dir_all(parent).map_err(|error| format!("无法创建资产目录: {error}"))?;
        let canonical_parent = parent
            .canonicalize()
            .map_err(|error| format!("无法确认资产目录: {error}"))?;
        if !canonical_parent.starts_with(&canonical_root) {
            return Err("资产路径逃逸了应用托管范围".to_string());
        }
        Ok(canonical_parent.join(
            candidate
                .file_name()
                .ok_or_else(|| "资产路径缺少文件名".to_string())?,
        ))
    }
}

fn descriptor_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<AssetDescriptor, String> {
    let media_kind = match row.get::<String, _>("media_kind").as_str() {
        "image" => AssetMediaKind::Image,
        "audio" => AssetMediaKind::Audio,
        _ => return Err("资产元数据中的媒体类别无效".to_string()),
    };
    let byte_length = u64::try_from(row.get::<i64, _>("byte_length"))
        .map_err(|_| "资产元数据中的长度无效".to_string())?;
    let pixel_width = row
        .get::<Option<i64>, _>("pixel_width")
        .map(u32::try_from)
        .transpose()
        .map_err(|_| "资产元数据中的图片宽度无效".to_string())?;
    let pixel_height = row
        .get::<Option<i64>, _>("pixel_height")
        .map(u32::try_from)
        .transpose()
        .map_err(|_| "资产元数据中的图片高度无效".to_string())?;
    Ok(AssetDescriptor {
        schema_version: 1,
        asset_id: row.get("asset_id"),
        media_kind,
        media_type: row.get("media_type"),
        byte_length,
        width: pixel_width,
        height: pixel_height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};

    fn tiny_png() -> Vec<u8> {
        let image = DynamicImage::ImageRgba8(ImageBuffer::from_pixel(2, 2, Rgba([1, 2, 3, 255])));
        let mut bytes = Cursor::new(Vec::new());
        image
            .write_to(&mut bytes, ImageFormat::Png)
            .expect("test PNG should encode");
        bytes.into_inner()
    }

    fn minimal_wav() -> Vec<u8> {
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&38_u32.to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16_u32.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&44_100_u32.to_le_bytes());
        wav.extend_from_slice(&88_200_u32.to_le_bytes());
        wav.extend_from_slice(&2_u16.to_le_bytes());
        wav.extend_from_slice(&16_u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&1_u32.to_le_bytes());
        wav.push(0);
        wav.push(0);
        wav
    }

    #[test]
    fn identical_normalized_images_are_content_addressed_once() {
        let root = tempfile::tempdir().expect("temporary asset root");
        let managed = root.path().join(HASH_DIRECTORY);
        let staging = root.path().join(TEMP_DIRECTORY);
        let first = persist_prepared_asset(
            &managed,
            &staging,
            prepare_asset(AssetMediaKind::Image, tiny_png(), Some("image/png"))
                .expect("image should normalize"),
        )
        .expect("first import should persist");
        let second = persist_prepared_asset(
            &managed,
            &staging,
            prepare_asset(AssetMediaKind::Image, tiny_png(), Some("image/png"))
                .expect("image should normalize"),
        )
        .expect("second import should deduplicate");

        assert_eq!(first.descriptor.asset_id, second.descriptor.asset_id);
        assert!(!first.deduplicated);
        assert!(second.deduplicated);

        let descriptor_json = serde_json::to_value(&first.descriptor).unwrap();
        assert_eq!(descriptor_json["schemaVersion"], 1);
        assert_eq!(descriptor_json["mediaType"], "image/webp");
        assert_eq!(descriptor_json["width"], 2);
        assert_eq!(descriptor_json["height"], 2);
        assert!(descriptor_json.get("mediaKind").is_none());
        assert!(descriptor_json.get("storageKey").is_none());
        assert!(descriptor_json.get("createdAt").is_none());
        assert!(descriptor_json.get("lastVerifiedAt").is_none());

        let import_json = serde_json::to_value(AssetImportResult {
            asset: first.descriptor.clone(),
            deduplicated: false,
        })
        .unwrap();
        assert_eq!(import_json["asset"], descriptor_json);
        assert_eq!(import_json["deduplicated"], false);
    }

    #[test]
    fn rejects_svg_gif_and_animated_webp() {
        assert!(prepare_asset(
            AssetMediaKind::Image,
            b"<svg xmlns='http://www.w3.org/2000/svg'/>".to_vec(),
            Some("image/svg+xml")
        )
        .is_err());
        assert!(prepare_asset(
            AssetMediaKind::Image,
            b"GIF89a-not-a-real-gif".to_vec(),
            None
        )
        .is_err());
        let mut animated = b"RIFF\x16\0\0\0WEBPANIM\0\0\0\0".to_vec();
        animated.extend_from_slice(b"ANMF\0\0\0\0");
        assert!(reject_animated_webp(&animated).is_err());
    }

    #[test]
    fn rejects_oversized_source_and_dimensions() {
        assert!(prepare_asset(
            AssetMediaKind::Image,
            vec![0; MAX_IMAGE_SOURCE_BYTES + 1],
            None
        )
        .is_err());
        assert!(prepare_asset(
            AssetMediaKind::Audio,
            vec![0; MAX_AUDIO_ASSET_BYTES + 1],
            None
        )
        .is_err());
        assert!(validate_image_dimensions(MAX_IMAGE_EDGE + 1, 1).is_err());
        assert!(validate_image_dimensions(8_000, 8_000).is_err());
    }

    #[test]
    fn room_download_chunk_geometry_and_storage_keys_are_bounded() {
        let length = ROOM_ASSET_CHUNK_BYTES as u64 * 2 + 17;
        assert_eq!(room_asset_chunk_count(length).unwrap(), 3);
        assert_eq!(
            room_asset_chunk_length(length, 0, 3).unwrap(),
            ROOM_ASSET_CHUNK_BYTES
        );
        assert_eq!(room_asset_chunk_length(length, 2, 3).unwrap(), 17);
        assert!(room_asset_chunk_length(length, 3, 3).is_err());

        let key = download_storage_key("room-safe", &format!("sha256:{}", "a".repeat(64)));
        assert!(validate_download_storage_key(&key).is_ok());
        assert!(validate_download_storage_key("../escape.part").is_err());
        assert!(validate_download_storage_key("download-ABC.part").is_err());
    }

    #[test]
    fn received_assets_keep_exact_bytes_and_repeat_native_validation() {
        let normalized = prepare_asset(AssetMediaKind::Image, tiny_png(), Some("image/png"))
            .expect("local image should normalize");
        let descriptor = ReceivedAssetDescriptor {
            schema_version: 1,
            asset_id: asset_id_for_bytes(&normalized.bytes),
            media_type: "image/webp".to_string(),
            byte_length: normalized.bytes.len() as u64,
            width: normalized.pixel_width,
            height: normalized.pixel_height,
            duration_ms: None,
        };
        let received = prepare_received_asset(&descriptor, normalized.bytes.clone())
            .expect("normalized WebP should pass exact-byte receiving");
        assert_eq!(received.bytes, normalized.bytes);

        let mut wrong_dimensions = descriptor.clone();
        wrong_dimensions.width = Some(3);
        assert!(prepare_received_asset(&wrong_dimensions, received.bytes.clone()).is_err());

        let mut wrong_hash = descriptor.clone();
        wrong_hash.asset_id = format!("sha256:{}", "0".repeat(64));
        assert!(prepare_received_asset(&wrong_hash, received.bytes).is_err());

        let wav = minimal_wav();
        let wrong_audio_type = ReceivedAssetDescriptor {
            schema_version: 1,
            asset_id: asset_id_for_bytes(&wav),
            media_type: "audio/ogg".to_string(),
            byte_length: wav.len() as u64,
            width: None,
            height: None,
            duration_ms: None,
        };
        assert!(prepare_received_asset(&wrong_audio_type, wav).is_err());
    }

    #[test]
    fn storage_key_cannot_escape_managed_root() {
        let id = format!("sha256:{}", "a".repeat(64));
        assert!(validate_storage_key(&id, "aa/../secret.webp").is_err());
        assert!(validate_storage_key(&id, "C:\\secret.webp").is_err());
        assert!(validate_storage_key(&id, &format!("aa/{}.webp", "b".repeat(64))).is_err());
        assert!(validate_storage_key(&id, &format!("aa/{}.webp", "a".repeat(64))).is_ok());
    }

    #[test]
    fn asset_reference_inputs_are_strict_and_bounded() {
        let id = format!("sha256:{}", "a".repeat(64));
        assert!(validate_asset_reference_input(
            &id,
            "location",
            "location_1",
            3,
            "background.image"
        )
        .is_ok());
        assert!(validate_asset_reference_input(
            &id,
            "arbitrary-owner",
            "location_1",
            3,
            "background.image"
        )
        .is_err());
        assert!(validate_asset_reference_input(&id, "npc", "../npc", 0, "portrait").is_err());
        assert!(validate_asset_reference_input(&id, "npc", "npc_1", -1, "portrait").is_err());
        assert!(validate_asset_reference_input(&id, "npc", "npc_1", 0, "../portrait").is_err());
    }

    #[test]
    fn validates_minimal_audio_containers() {
        let wav = minimal_wav();
        assert!(is_valid_wav(&wav));
        assert_eq!(detect_audio_format(&wav).unwrap(), ("audio/wav", "wav"));

        let frame_header = [0xff, 0xfb, 0x90, 0x64];
        let frame_length = mp3_frame_length(&frame_header).expect("valid MP3 frame header");
        let mut mp3 = vec![0_u8; frame_length * 2];
        mp3[..4].copy_from_slice(&frame_header);
        mp3[frame_length..frame_length + 4].copy_from_slice(&frame_header);
        assert!(is_valid_mp3(&mp3));
        assert_eq!(detect_audio_format(&mp3).unwrap(), ("audio/mpeg", "mp3"));
        assert!(!is_valid_mp3(&frame_header));

        let mut ogg = vec![0_u8; 27];
        ogg[..4].copy_from_slice(b"OggS");
        ogg[5] = 0x02;
        ogg[26] = 1;
        ogg.push(19);
        ogg.extend_from_slice(b"OpusHead");
        ogg.extend_from_slice(&[0_u8; 11]);
        assert!(is_valid_ogg_audio(&ogg));
        assert_eq!(detect_audio_format(&ogg).unwrap(), ("audio/ogg", "ogg"));

        assert!(!is_valid_mp3(&[0xff]));
        assert!(detect_audio_format(b"not audio").is_err());
    }
}
