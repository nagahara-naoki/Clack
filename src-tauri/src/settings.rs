// SPDX-License-Identifier: MIT
//! ユーザー設定 (`settings.json`) の定義・読み書き・検証。
//!
//! 公開設定項目:
//!
//! - **`idle_threshold_seconds`**: 入力が無くなってから何秒で計数を
//!   停止するか。[5, 3600] に制限。5 秒未満だと自然な打鍵の合間にも
//!   止まってしまい、1 時間を超えるとアイドル判定そのものが破綻する。
//! - **`theme`**: `"light" | "dark" | "auto"`。`"auto"` は OS のテーマに追従。
//! - **`language`**: `"ja" | "en"`。フロントの表示言語。
//! - **`months_shown`**: ヒートマップの表示期間 (1, 3, 6, 12 のいずれか)。
//!
//! 自動起動の有無は `tauri-plugin-autostart` が OS 側 (Windows のレジストリ
//! `HKCU\...\Run`、macOS の LaunchAgent plist) に書き込むため、本構造体
//! には含めない。

use std::fs;
use std::io::{self, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};

/// アイドル閾値 (秒) の下限。短すぎると通常の打鍵間休止にもヒットする。
const MIN_IDLE_SECS: u64 = 5;
/// アイドル閾値 (秒) の上限。
const MAX_IDLE_SECS: u64 = 3600;

/// 許可されるテーマ値。これ以外はバリデーション失敗。
const ALLOWED_THEMES: &[&str] = &["light", "dark", "auto"];

/// 許可される言語値。フロント側 i18n 辞書と必ず同期させること。
const ALLOWED_LANGUAGES: &[&str] = &["ja", "en"];

/// 許可されるヒートマップ表示期間 (月数)。
const ALLOWED_MONTHS: &[u32] = &[1, 3, 6, 12];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default = "default_idle")]
    pub idle_threshold_seconds: u64,
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(default = "default_months_shown")]
    pub months_shown: u32,
}

fn default_idle() -> u64 { 60 }
fn default_theme() -> String { "auto".to_string() }
fn default_language() -> String { "ja".to_string() }
fn default_months_shown() -> u32 { 6 }

impl Default for Settings {
    fn default() -> Self {
        Self {
            idle_threshold_seconds: default_idle(),
            theme: default_theme(),
            language: default_language(),
            months_shown: default_months_shown(),
        }
    }
}

impl Settings {
    /// `settings.json` を読み込む。失敗時はデフォルト値を返す
    /// (設定ファイルが壊れていてもアプリ自体は必ず起動する)。
    pub fn read(path: &Path) -> Self {
        fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str::<Self>(&s).ok())
            .unwrap_or_default()
    }

    /// アトミック書き込み (storage と同じ tmp + rename パターン)。
    pub fn write(&self, path: &Path) -> io::Result<()> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp_path = path.with_extension("json.tmp");
        let bytes =
            serde_json::to_vec_pretty(self).map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
        {
            let mut f = fs::File::create(&tmp_path)?;
            f.write_all(&bytes)?;
            f.sync_all()?;
        }
        fs::rename(&tmp_path, path)
    }

    /// 書き込み前の検証。`update_settings` IPC コマンドから呼ばれ、
    /// 失敗時はフロントにエラー文言が返る。
    pub fn validate(&self) -> Result<(), String> {
        if !(MIN_IDLE_SECS..=MAX_IDLE_SECS).contains(&self.idle_threshold_seconds) {
            return Err(format!(
                "idle_threshold_seconds must be in {MIN_IDLE_SECS}..={MAX_IDLE_SECS}"
            ));
        }
        if !ALLOWED_THEMES.contains(&self.theme.as_str()) {
            return Err(format!("theme must be one of {:?}", ALLOWED_THEMES));
        }
        if !ALLOWED_LANGUAGES.contains(&self.language.as_str()) {
            return Err(format!("language must be one of {:?}", ALLOWED_LANGUAGES));
        }
        if !ALLOWED_MONTHS.contains(&self.months_shown) {
            return Err(format!("months_shown must be one of {:?}", ALLOWED_MONTHS));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_valid() {
        Settings::default().validate().unwrap();
    }

    #[test]
    fn rejects_invalid_threshold() {
        let s = Settings { idle_threshold_seconds: 0, ..Settings::default() };
        assert!(s.validate().is_err());
        let s = Settings { idle_threshold_seconds: 4000, ..Settings::default() };
        assert!(s.validate().is_err());
    }

    #[test]
    fn rejects_invalid_theme() {
        let s = Settings { theme: "blue".into(), ..Settings::default() };
        assert!(s.validate().is_err());
        let s = Settings { theme: String::new(), ..Settings::default() };
        assert!(s.validate().is_err());
    }

    #[test]
    fn rejects_invalid_language() {
        let s = Settings { language: "fr".into(), ..Settings::default() };
        assert!(s.validate().is_err());
    }

    #[test]
    fn accepts_ja_and_en() {
        let mut s = Settings::default();
        s.language = "en".into();
        s.validate().unwrap();
        s.language = "ja".into();
        s.validate().unwrap();
    }

    #[test]
    fn rejects_invalid_months_shown() {
        let s = Settings { months_shown: 4, ..Settings::default() };
        assert!(s.validate().is_err());
        let s = Settings { months_shown: 0, ..Settings::default() };
        assert!(s.validate().is_err());
    }

    #[test]
    fn accepts_all_allowed_months() {
        for &m in &[1u32, 3, 6, 12] {
            let s = Settings { months_shown: m, ..Settings::default() };
            s.validate().unwrap();
        }
    }
}
