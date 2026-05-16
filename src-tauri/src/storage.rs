// SPDX-License-Identifier: MIT
//! 1 日ごとの集計を JSON ファイルに永続化する。
//!
//! 【ファイル形式】
//! ```json
//! {
//!   "2026-05-14": {
//!     "keys": 8742,
//!     "mouse": 1124,
//!     "keyBreakdown": { "KeyA": 312, "Return": 88 },
//!     "mouseBreakdown": { "Left": 980 }
//!   }
//! }
//! ```
//!
//! 【信頼境界】
//! `data.json` はユーザーのデータディレクトリ
//! (Windows: `%APPDATA%\Clack\`, macOS: `~/Library/Application
//! Support/Clack/`) に置かれる。攻撃者が書き換えるシナリオは
//! 想定せず、最悪「ユーザーがエディタで壊した」程度を仮定する。
//! 解析失敗時は空マップを返してアプリは新規データから再開する。

use std::collections::HashMap;
use std::fs;
use std::io::{self, Write};
use std::path::Path;

use crate::counter::DayStats;

/// ディスク上のスキーマ: `"YYYY-MM-DD"` → 1 日分集計。
pub type Data = HashMap<String, DayStats>;

/// 読み込み (ベストエフォート)。
/// ファイルが無い・パースに失敗した場合は空マップを返す (panic しない)。
/// パースエラーは stderr にログするが、UI には伝搬しない (静かに復帰)。
pub fn read(path: &Path) -> Data {
    match fs::read_to_string(path) {
        Ok(s) if !s.trim().is_empty() => serde_json::from_str::<Data>(&s).unwrap_or_else(|e| {
            eprintln!("data.json parse error: {e}; starting with empty history");
            HashMap::new()
        }),
        _ => HashMap::new(),
    }
}

/// アトミック書き込み。
/// 一時ファイルにフラッシュして `fsync` した後、`rename` で本来のパスに
/// 差し替える。Windows (NTFS) / macOS (APFS) のいずれでも同ボリュームの
/// `rename` はアトミックなので、書き込み中の電源断・クラッシュでも
/// 旧ファイルが壊れることはない。
pub fn write_atomic(path: &Path, data: &Data) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp_path = path.with_extension("json.tmp");
    let bytes =
        serde_json::to_vec(data).map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
    {
        let mut f = fs::File::create(&tmp_path)?;
        f.write_all(&bytes)?;
        // sync_all で OS バッファをフラッシュしてから rename。
        // これが無いと、電源断で 0 バイトファイルが残るリスクがある。
        f.sync_all()?;
    }
    fs::rename(&tmp_path, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn round_trip_preserves_values() {
        let dir = env::temp_dir().join("clickcounter_test_storage");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("data.json");

        let mut data = HashMap::new();
        data.insert(
            "2026-05-14".to_string(),
            DayStats {
                keys: 100,
                mouse: 20,
                ..Default::default()
            },
        );
        write_atomic(&path, &data).unwrap();

        let back = read(&path);
        assert_eq!(back.get("2026-05-14").cloned().unwrap_or_default().keys, 100);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_file_returns_empty() {
        let path = Path::new("/nonexistent/__clickcounter_missing__.json");
        assert!(read(path).is_empty());
    }

    #[test]
    fn malformed_json_returns_empty_without_panic() {
        let dir = env::temp_dir().join("clickcounter_test_storage_bad");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("data.json");
        fs::write(&path, "this is not json {{{").unwrap();
        assert!(read(&path).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}
