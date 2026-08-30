use hmac::{Hmac, Mac};
use keyring::Entry;
use sha2::{Digest, Sha256};
use sqlx::{Pool, Sqlite};
use tauri::State;
use tauri_plugin_sql::{DbInstances, DbPool};
use zeroize::Zeroizing;

type HmacSha256 = Hmac<Sha256>;

const DATABASE_URL: &str = "sqlite:coc-room.db";
const KEYRING_SERVICE: &str = "org.coc-room.desktop";
const ACCOUNT_DOMAIN: &[u8] = b"coc-room:seat-account:v1\0";
const VERIFIER_DOMAIN: &[u8] = b"coc-room:seat-verifier:v1\0";
const PROOF_DOMAIN: &[u8] = b"coc-room:seat-proof:v1\0";
const ROOM_ID_MIN_BYTES: usize = 16;
const ROOM_ID_MAX_BYTES: usize = 64;
const SEAT_ID_MAX_BYTES: usize = 64;
const SECRET_MIN_BYTES: usize = 32;
const SECRET_MAX_BYTES: usize = 256;
const NONCE_MIN_BYTES: usize = 16;
const NONCE_MAX_BYTES: usize = 128;

#[tauri::command]
pub(crate) fn save_room_seat_secret(
    room_id: String,
    seat_id: String,
    secret: String,
) -> Result<(), String> {
    validate_room_and_seat(&room_id, &seat_id)?;
    let secret = Zeroizing::new(secret);
    validate_url_safe_secret(&secret, SECRET_MIN_BYTES, SECRET_MAX_BYTES, "席位 secret")?;
    seat_keyring_entry("secret", &room_id, &seat_id)?
        .set_password(secret.as_str())
        .map_err(|_| "无法安全保存席位凭据".to_string())
}

#[tauri::command]
pub(crate) fn compute_room_seat_proof(
    room_id: String,
    seat_id: String,
    nonce: String,
) -> Result<String, String> {
    validate_room_and_seat(&room_id, &seat_id)?;
    validate_url_safe_secret(&nonce, NONCE_MIN_BYTES, NONCE_MAX_BYTES, "席位 nonce")?;
    let secret = Zeroizing::new(
        seat_keyring_entry("secret", &room_id, &seat_id)?
            .get_password()
            .map_err(|_| "本机没有该席位凭据".to_string())?,
    );
    validate_url_safe_secret(&secret, SECRET_MIN_BYTES, SECRET_MAX_BYTES, "席位 secret")?;
    let verifier = Zeroizing::new(derive_verifier(secret.as_bytes()));
    Ok(compute_proof_hex(
        verifier.as_ref(),
        &room_id,
        &seat_id,
        &nonce,
    ))
}

#[tauri::command]
pub(crate) async fn save_room_seat_verifier(
    databases: State<'_, DbInstances>,
    room_id: String,
    seat_id: String,
    derived_verifier: String,
) -> Result<(), String> {
    validate_room_and_seat(&room_id, &seat_id)?;
    let derived_verifier = Zeroizing::new(derived_verifier);
    let decoded = Zeroizing::new(decode_digest(&derived_verifier, "派生 verifier")?);
    store_room_seat_verifier(&databases, &room_id, &seat_id, decoded.as_ref()).await
}

#[tauri::command]
pub(crate) async fn register_room_seat_verifier(
    databases: State<'_, DbInstances>,
    room_id: String,
    seat_id: String,
    secret: String,
) -> Result<(), String> {
    validate_room_and_seat(&room_id, &seat_id)?;
    let secret = Zeroizing::new(secret);
    validate_url_safe_secret(&secret, SECRET_MIN_BYTES, SECRET_MAX_BYTES, "席位 secret")?;
    let verifier = Zeroizing::new(derive_verifier(secret.as_bytes()));
    store_room_seat_verifier(&databases, &room_id, &seat_id, verifier.as_ref()).await
}

async fn store_room_seat_verifier(
    databases: &DbInstances,
    room_id: &str,
    seat_id: &str,
    verifier: &[u8],
) -> Result<(), String> {
    let encoded_verifier = Zeroizing::new(lowercase_hex(verifier));
    let entry = seat_keyring_entry("verifier", &room_id, &seat_id)?;
    let previous = entry.get_password().ok().map(Zeroizing::new);
    entry
        .set_password(encoded_verifier.as_str())
        .map_err(|_| "无法安全保存席位验证凭据".to_string())?;

    let pool = database_pool(databases).await?;
    let result = sqlx::query(
        r#"INSERT INTO room_seat_verifiers (
             room_id, seat_id, kdf_version, proof_version, created_at, updated_at
           ) VALUES (
             ?, ?, 1, 1,
             strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             strftime('%Y-%m-%dT%H:%M:%fZ','now')
           ) ON CONFLICT(room_id, seat_id) DO UPDATE SET
             kdf_version=1,
             proof_version=1,
             updated_at=excluded.updated_at"#,
    )
    .bind(room_id)
    .bind(seat_id)
    .execute(&pool)
    .await;
    if let Err(error) = result {
        if let Some(previous) = previous {
            let _ = entry.set_password(previous.as_str());
        } else {
            let _ = entry.delete_credential();
        }
        return Err(format!("无法保存席位验证元数据: {error}"));
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn compute_expected_seat_proof(
    room_id: String,
    seat_id: String,
    nonce: String,
) -> Result<String, String> {
    validate_room_and_seat(&room_id, &seat_id)?;
    validate_url_safe_secret(&nonce, NONCE_MIN_BYTES, NONCE_MAX_BYTES, "席位 nonce")?;
    let encoded = Zeroizing::new(
        seat_keyring_entry("verifier", &room_id, &seat_id)?
            .get_password()
            .map_err(|_| "本机没有该席位的验证凭据".to_string())?,
    );
    let verifier = Zeroizing::new(decode_digest(&encoded, "派生 verifier")?);
    Ok(compute_proof_hex(
        verifier.as_ref(),
        &room_id,
        &seat_id,
        &nonce,
    ))
}

#[tauri::command]
pub(crate) fn verify_room_seat_proof(
    room_id: String,
    seat_id: String,
    nonce: String,
    supplied_proof: String,
) -> Result<bool, String> {
    validate_room_and_seat(&room_id, &seat_id)?;
    validate_url_safe_secret(&nonce, NONCE_MIN_BYTES, NONCE_MAX_BYTES, "席位 nonce")?;
    let encoded = Zeroizing::new(
        seat_keyring_entry("verifier", &room_id, &seat_id)?
            .get_password()
            .map_err(|_| "本机没有该席位的验证凭据".to_string())?,
    );
    let verifier = Zeroizing::new(decode_digest(&encoded, "派生 verifier")?);
    Ok(verify_proof(
        verifier.as_ref(),
        &room_id,
        &seat_id,
        &nonce,
        &supplied_proof,
    ))
}

async fn database_pool(databases: &DbInstances) -> Result<Pool<Sqlite>, String> {
    let instances = databases.0.read().await;
    match instances.get(DATABASE_URL) {
        Some(DbPool::Sqlite(pool)) => Ok(pool.clone()),
        None => Err("本地数据库尚未初始化".to_string()),
    }
}

fn seat_keyring_entry(kind: &str, room_id: &str, seat_id: &str) -> Result<Entry, String> {
    let account = seat_keyring_account(kind, room_id, seat_id)?;
    Entry::new(KEYRING_SERVICE, &account).map_err(|_| "无法访问系统凭据管理器".to_string())
}

fn seat_keyring_account(kind: &str, room_id: &str, seat_id: &str) -> Result<String, String> {
    validate_room_and_seat(room_id, seat_id)?;
    if kind != "secret" && kind != "verifier" {
        return Err("席位凭据类别无效".to_string());
    }
    let mut hasher = Sha256::new();
    hasher.update(ACCOUNT_DOMAIN);
    update_length_prefixed(&mut hasher, room_id.as_bytes());
    update_length_prefixed(&mut hasher, seat_id.as_bytes());
    Ok(format!(
        "room-seat-{kind}-v1:{}",
        lowercase_hex(&hasher.finalize())
    ))
}

fn derive_verifier(secret: &[u8]) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC accepts arbitrary key lengths");
    mac.update(VERIFIER_DOMAIN);
    let digest = mac.finalize().into_bytes();
    let mut output = [0_u8; 32];
    output.copy_from_slice(&digest);
    output
}

fn compute_proof_hex(verifier: &[u8], room_id: &str, seat_id: &str, nonce: &str) -> String {
    lowercase_hex(
        &proof_mac(verifier, room_id, seat_id, nonce)
            .finalize()
            .into_bytes(),
    )
}

fn verify_proof(
    verifier: &[u8],
    room_id: &str,
    seat_id: &str,
    nonce: &str,
    supplied_proof: &str,
) -> bool {
    let Ok(supplied) = decode_digest(supplied_proof, "席位 proof") else {
        return false;
    };
    proof_mac(verifier, room_id, seat_id, nonce)
        .verify_slice(&supplied)
        .is_ok()
}

fn proof_mac(verifier: &[u8], room_id: &str, seat_id: &str, nonce: &str) -> HmacSha256 {
    let mut mac = HmacSha256::new_from_slice(verifier).expect("HMAC accepts arbitrary key lengths");
    mac.update(PROOF_DOMAIN);
    update_mac_length_prefixed(&mut mac, room_id.as_bytes());
    update_mac_length_prefixed(&mut mac, seat_id.as_bytes());
    update_mac_length_prefixed(&mut mac, nonce.as_bytes());
    mac
}

fn update_length_prefixed(hasher: &mut Sha256, bytes: &[u8]) {
    hasher.update((bytes.len() as u16).to_be_bytes());
    hasher.update(bytes);
}

fn update_mac_length_prefixed(mac: &mut HmacSha256, bytes: &[u8]) {
    mac.update(&(bytes.len() as u16).to_be_bytes());
    mac.update(bytes);
}

fn validate_room_and_seat(room_id: &str, seat_id: &str) -> Result<(), String> {
    validate_identifier(room_id, ROOM_ID_MIN_BYTES, ROOM_ID_MAX_BYTES, "房间 ID")?;
    validate_identifier(seat_id, 1, SEAT_ID_MAX_BYTES, "席位 ID")
}

fn validate_identifier(
    value: &str,
    minimum: usize,
    maximum: usize,
    label: &str,
) -> Result<(), String> {
    let bytes = value.as_bytes();
    if bytes.len() < minimum
        || bytes.len() > maximum
        || !bytes[0].is_ascii_alphanumeric()
        || !bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'.' | b'_' | b':' | b'-'))
    {
        return Err(format!(
            "{label} 必须是 {minimum} 到 {maximum} 字节的 URL 安全标识符"
        ));
    }
    Ok(())
}

fn validate_url_safe_secret(
    value: &str,
    minimum: usize,
    maximum: usize,
    label: &str,
) -> Result<(), String> {
    let bytes = value.as_bytes();
    if bytes.len() < minimum
        || bytes.len() > maximum
        || !bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'_' | b'-'))
    {
        return Err(format!(
            "{label} 必须是 {minimum} 到 {maximum} 字节的无填充 Base64URL/十六进制文本"
        ));
    }
    Ok(())
}

fn decode_digest(value: &str, label: &str) -> Result<[u8; 32], String> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!("{label} 必须是 64 位小写 SHA-256 十六进制文本"));
    }
    let mut decoded = [0_u8; 32];
    for (index, chunk) in value.as_bytes().chunks_exact(2).enumerate() {
        decoded[index] = (hex_nibble(chunk[0], label)? << 4) | hex_nibble(chunk[1], label)?;
    }
    Ok(decoded)
}

fn hex_nibble(value: u8, label: &str) -> Result<u8, String> {
    match value {
        b'0'..=b'9' => Ok(value - b'0'),
        b'a'..=b'f' => Ok(value - b'a' + 10),
        _ => Err(format!("{label} 包含无效字符")),
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    const ROOM: &str = "room_abcdefghijklmnop";
    const SEAT: &str = "investigator-1";
    const SECRET: &str = "abcdefghijklmnopqrstuvwxyzABCDEF0123456789_-";
    const NONCE: &str = "nonce_abcdefghijklmnop";

    #[test]
    fn keyring_accounts_are_stable_and_domain_separated() {
        let secret = seat_keyring_account("secret", ROOM, SEAT).unwrap();
        assert_eq!(secret, seat_keyring_account("secret", ROOM, SEAT).unwrap());
        assert_ne!(
            secret,
            seat_keyring_account("verifier", ROOM, SEAT).unwrap()
        );
        assert_ne!(
            secret,
            seat_keyring_account("secret", ROOM, "investigator-2").unwrap()
        );
        assert!(!secret.contains(ROOM));
        assert!(!secret.contains(SEAT));
    }

    #[test]
    fn player_and_host_compute_the_same_domain_bound_proof() {
        let verifier = derive_verifier(SECRET.as_bytes());
        let encoded = lowercase_hex(&verifier);
        assert_eq!(decode_digest(&encoded, "verifier").unwrap(), verifier);
        let player = compute_proof_hex(&verifier, ROOM, SEAT, NONCE);
        let host = compute_proof_hex(
            &decode_digest(&encoded, "verifier").unwrap(),
            ROOM,
            SEAT,
            NONCE,
        );
        assert_eq!(player, host);
        assert!(verify_proof(&verifier, ROOM, SEAT, NONCE, &player));
        assert_ne!(
            player,
            compute_proof_hex(&verifier, ROOM, SEAT, "nonce_abcdefghijklmnop2")
        );
    }

    #[test]
    fn proof_verification_rejects_mutated_or_malformed_values() {
        let verifier = derive_verifier(SECRET.as_bytes());
        let proof = compute_proof_hex(&verifier, ROOM, SEAT, NONCE);
        assert!(verify_proof(&verifier, ROOM, SEAT, NONCE, &proof));

        let mut mutated = proof.into_bytes();
        mutated[0] = if mutated[0] == b'0' { b'1' } else { b'0' };
        let mutated = String::from_utf8(mutated).unwrap();
        assert!(!verify_proof(&verifier, ROOM, SEAT, NONCE, &mutated));
        assert!(!verify_proof(&verifier, ROOM, SEAT, NONCE, "too-short"));
        assert!(!verify_proof(&verifier, ROOM, SEAT, NONCE, &"A".repeat(64)));
        assert!(!verify_proof(
            &verifier,
            ROOM,
            "investigator-2",
            NONCE,
            &compute_proof_hex(&verifier, ROOM, SEAT, NONCE)
        ));
    }

    #[test]
    fn credential_inputs_have_strict_bounds_and_character_sets() {
        assert!(validate_room_and_seat(ROOM, SEAT).is_ok());
        assert!(validate_room_and_seat("short", SEAT).is_err());
        assert!(validate_room_and_seat(ROOM, "../seat").is_err());
        assert!(
            validate_url_safe_secret(SECRET, SECRET_MIN_BYTES, SECRET_MAX_BYTES, "secret").is_ok()
        );
        assert!(validate_url_safe_secret("contains=padding", 1, 128, "secret").is_err());
        assert!(decode_digest(&"a".repeat(64), "verifier").is_ok());
        assert!(decode_digest(&"A".repeat(64), "verifier").is_err());
    }
}
