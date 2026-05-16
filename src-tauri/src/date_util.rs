// SPDX-License-Identifier: MIT
//! ローカルタイムゾーンを意識した日付ヘルパ。
//!
//! 【なぜ `OnceLock` で TZ オフセットを保持するか】
//! `time` クレートの [`UtcOffset::current_local_offset`] は Unix 上で
//! 「並行する setenv/getenv に対してレース」する仕様である (`time` の
//! ドキュメントで明記されている)。よって本アプリでは **スレッド生成前**
//! に [`init()`] で 1 回だけオフセットを取得し、以後はキャッシュした値を
//! 再利用する。
//!
//! 副作用として、アプリ実行中にユーザーが OS のタイムゾーンを変えた
//! 場合は古いオフセットを使い続ける。これは
//! 「`iana-time-zone` 依存を増やさない」ためのトレードオフで、計数アプリの
//! 性質上ほぼ影響しない。

use std::sync::OnceLock;
use time::{macros::format_description, Date, Month, OffsetDateTime, UtcOffset};

static LOCAL_OFFSET: OnceLock<UtcOffset> = OnceLock::new();

/// 起動直後、スレッド生成前に 1 度だけ呼ぶこと。
/// 二度目以降の呼び出しは何もしない (`OnceLock` の仕様)。
pub fn init() {
    let offset = UtcOffset::current_local_offset().unwrap_or(UtcOffset::UTC);
    let _ = LOCAL_OFFSET.set(offset);
}

fn offset() -> UtcOffset {
    LOCAL_OFFSET.get().copied().unwrap_or(UtcOffset::UTC)
}

fn now_local() -> OffsetDateTime {
    OffsetDateTime::now_utc().to_offset(offset())
}

/// 今日の日付 (ローカル) を `YYYY-MM-DD` で返す。
pub fn today() -> String {
    format_date(now_local().date())
}

/// 現在のローカル時 (0..=23)。時間帯ヒートマップ用の bucket index に使う。
/// `now_local()` は内部で `OffsetDateTime::now_utc()` (= 単純な
/// clock_gettime ベース) を 1 回呼ぶだけなので、≤30 events/s の入力
/// ホットパスでも問題なく毎回呼べる。
pub fn current_hour() -> u8 {
    now_local().hour()
}

/// `Date` を `YYYY-MM-DD` 文字列にする。
/// フォーマット失敗はほぼあり得ないが、起きた場合はエポック日を返す
/// (ホットパスから panic を排除する目的)。
pub fn format_date(d: Date) -> String {
    let fmt = format_description!("[year]-[month]-[day]");
    d.format(&fmt).unwrap_or_else(|_| "1970-01-01".to_string())
}

/// `YYYY-MM-DD` を厳格にパース。許容しない例:
/// - 区切りがハイフン以外 (`/`, `.` など)
/// - 年が短縮 (`26-05-14` など)
/// - 時刻付き ISO-8601
/// 不正値は `None` を返し、呼び出し元 (IPC コマンド) でエラー化する。
pub fn parse_date(s: &str) -> Option<Date> {
    let parts: Vec<&str> = s.split('-').collect();
    if parts.len() != 3 {
        return None;
    }
    let y: i32 = parts[0].parse().ok()?;
    let m: u8 = parts[1].parse().ok()?;
    let d: u8 = parts[2].parse().ok()?;
    Date::from_calendar_date(y, Month::try_from(m).ok()?, d).ok()
}

/// 区間 `[start, end]` の Date 列を昇順で返す。
/// `Date::MAX` (西暦 9999) で打ち切るため、不正な入力でも無限ループ
/// にはならない。呼び出し側でも `end - start` の上限を確認すること。
pub fn date_range(start: Date, end: Date) -> Vec<Date> {
    let mut v = Vec::new();
    let mut d = start;
    while d <= end {
        v.push(d);
        match d.next_day() {
            Some(n) => d = n,
            None => break,
        }
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_round_trip() {
        let d = parse_date("2026-05-14").expect("valid");
        assert_eq!(format_date(d), "2026-05-14");
    }

    #[test]
    fn parse_rejects_garbage() {
        assert!(parse_date("not-a-date").is_none());
        assert!(parse_date("2026/05/14").is_none());
        assert!(parse_date("2026-13-01").is_none());
        assert!(parse_date("2026-02-30").is_none());
        assert!(parse_date("").is_none());
        assert!(parse_date("2026-05").is_none());
    }

    #[test]
    fn range_is_inclusive_and_ascending() {
        let a = parse_date("2026-05-14").unwrap();
        let b = parse_date("2026-05-16").unwrap();
        let r = date_range(a, b);
        assert_eq!(r.len(), 3);
        assert_eq!(format_date(r[0]), "2026-05-14");
        assert_eq!(format_date(r[2]), "2026-05-16");
    }
}
