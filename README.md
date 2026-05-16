<div align="center">

<img src="icons/icon-256.png" alt="Clack" width="128" height="128" />

# Clack

**毎日の入力を、暦の上に。**

キーボードとマウスを 1 日 1 マスで記録する、ローカル完結のデスクトップアプリ。

[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-0078d6?style=flat-square)](#動作環境)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-FFC131?style=flat-square)](https://tauri.app)
[![Made with Rust](https://img.shields.io/badge/made%20with-Rust-CE4124?style=flat-square&logo=rust)](https://www.rust-lang.org)

[**📥 最新版をダウンロード**](https://github.com/YOUR-USERNAME/clack/releases/latest) ・ [紹介ページ](https://YOUR-USERNAME.github.io/clack/) ・ **日本語** / [English](README.en.md)

</div>

---

## 目次

- [概要](#概要)
- [機能](#機能)
- [ダウンロード](#ダウンロード) (Windows / macOS)
- [スクリーンショット](#スクリーンショット)
- [使い方](#使い方)
- [プライバシー](#プライバシー)
- [データ形式](#データ形式)
- [ビルド](#ビルド-ソースから)
- [技術スタック](#技術スタック)
- [アーキテクチャ](#アーキテクチャ)
- [貢献 / ライセンス](#貢献)

---

## 概要

Clack はキーボードとマウスの操作回数を **1 日ごと** に記録し、GitHub のコントリビューショングラフのようなヒートマップで可視化するデスクトップアプリです。

- 🟢 **完全オフライン** — ネットワーク呼び出しは 0 件。データは端末内に閉じます
- 🟢 **軽量** — 実行ファイル 5 MB / メモリは最小限。24 時間トレイ常駐前提
- 🟢 **クロスプラットフォーム** — Windows 10 / 11、macOS 10.15+ (Intel / Apple Silicon)
- 🟢 **オープンソース** — MIT ライセンス、すべてのコードが公開されています

---

## 機能

### 📅 記録

| 機能 | 内容 |
| --- | --- |
| カレンダーヒートマップ | 1 日 1 マスの 5 段階色分け。1ヶ月 / 3ヶ月 / 6ヶ月 / 12ヶ月で表示期間を切替 |
| リスト表示 | 日付・キー数・マウス数を表形式で確認 |
| 当月累計 | フッターに常時表示 |
| アイドル除外 | 設定した秒数 (既定 60 秒) 無操作で自動的に計数停止 |
| オートリピート抑制 | キーを押しっぱなしでも 1 回とカウント |

### 📊 分析

| 機能 | 内容 |
| --- | --- |
| キー / マウス内訳 | よく使うキー Top 30 の横棒チャート |
| 時間帯ヒートマップ | 0〜23 時の活動量を 24 セルで |
| 連続日数 (ストリーク) | 今日まで連続して入力した日数 |
| 最多日 | 全期間で最も活発だった日 |
| スコープ切替 | 今日 / 7 日 / 今月 / 全期間 をワンクリック |

### ⚡ リアルタイム表示

| 機能 | 内容 |
| --- | --- |
| 入力即時表示 | 押したキーを常に最前面の小窓に表示 |
| 同時押し統合 | `Shift + 1` のような組み合わせを 1 つのチップに |
| スタックモード | 直近 100 件まで履歴を残せる切替 |
| 自由移動 | ドラッグで任意の位置へ。透過オーバーレイ |

### 💾 バックアップ

| 機能 | 内容 |
| --- | --- |
| JSON エクスポート | 全データ + 設定を完全形式で書き出し |
| CSV エクスポート | `date,keys,mouse,total,h0..h23` で表計算ソフトに直結 |
| JSON インポート | バックアップ復元 (2 段階確認付き) |
| 個別削除 | 設定画面から全データ削除 (確認 + トースト) |

### 🛠 その他

| 機能 | 内容 |
| --- | --- |
| トレイ常駐 | × ボタンで終了せず、メニューから明示終了 |
| 自動起動 | OS 起動時に最小化で常駐 (オプトイン) |
| 一時停止 | 計測を一時停止 (再起動でリセット) |
| 日本語 / English | UI 切替対応 |
| ライト / ダーク / 自動 | テーマ切替 |

---

## ダウンロード

→ [**最新リリース**](https://github.com/YOUR-USERNAME/clack/releases/latest)

### Windows

| 形式 | ファイル | 用途 |
| --- | --- | --- |
| **NSIS インストーラ** | `Clack_x.x.x_x64-setup.exe` | 通常の Windows インストール |
| **MSI インストーラ** | `Clack_x.x.x_x64_en-US.msi` | エンタープライズ環境 / GPO 配布 |
| **ポータブル版** | `clack.exe` + `WebView2Loader.dll` | インストール不要、フォルダ単体で動作 |

### macOS

| 形式 | ファイル | 用途 |
| --- | --- | --- |
| **ユニバーサル DMG** | `Clack_x.x.x_universal.dmg` | Intel / Apple Silicon の両対応 |

### 動作環境

| OS | 要件 |
| --- | --- |
| Windows | 10 / 11 (x86_64)、WebView2 Runtime (Win11 標準搭載) |
| macOS | 10.15 Catalina 以降 (Intel / Apple Silicon どちらも可) |

> **🟡 Windows: SmartScreen の警告**
> 署名なしバイナリのため、初回実行時に Windows Defender SmartScreen の警告が出ます。「詳細情報」→「実行」で起動できます。

> **🟡 macOS: Gatekeeper の警告 + 入力監視権限**
> 署名なしのため、`.app` をダブルクリックすると「開発元を確認できません」と出ます。**右クリック → 開く** で 1 回だけ許可してください。
> その後、システム設定 → **プライバシーとセキュリティ → 入力監視** と **アクセシビリティ** の両方で Clack を ON にしてください。macOS ではキーボードのグローバル監視に両方が必要になることがあります。

### macOS インストール手順（詳細）

1. `.dmg` をダウンロードして開き、`Clack.app` を `Applications` にドラッグ
2. `Clack.app` を **右クリック** → 「開く」→ ダイアログで「開く」を選択（初回のみ）
3. システム設定 → プライバシーとセキュリティ → 入力監視 で `Clack` を ON
4. 必要に応じて、同じ画面のアクセシビリティでも `Clack` を ON
5. アプリを再起動して完了

---

## スクリーンショット

<div align="center">

<!-- スクリーンショットを screenshots/ に追加してパスを差し替え -->

| メイン (カレンダー) | 分析 |
| --- | --- |
| ![Calendar](screenshots/main.png) | ![Analytics](screenshots/analytics.png) |

| リアルタイム表示 | 設定 |
| --- | --- |
| ![Live](screenshots/live.png) | ![Settings](screenshots/settings.png) |

</div>

---

## 使い方

### 初回起動

ダブルクリックで起動すると、メインウィンドウが表示されます。
2 回目以降は **タスクトレイに常駐** し、トレイアイコンの左クリック / 右クリックメニューから操作します。

### トレイメニュー

| 項目 | 動作 |
| --- | --- |
| ウィンドウを開く | メイン画面を表示 |
| 一時停止 | 計測を一時停止 (再起動で OFF に戻る) |
| リアルタイム表示 | 入力チップを流す小窓を開閉 |
| 自動起動 | OS 起動時に Clack を自動で立ち上げる |
| 設定… | 設定ウィンドウ |
| 終了 | 最終フラッシュ後にプロセス終了 |

### キーボードショートカット (設定画面)

| キー | 動作 |
| --- | --- |
| `Esc` | キャンセル |
| `Ctrl + Enter` | 保存 |

---

## プライバシー

> ### **ネットワーク呼び出しは、0 件。**
>
> アプリのソースコードに HTTP / TCP を扱うライブラリは含まれていません。
> データが端末を離れる構造的な経路がそもそも存在しません。

### 記録されるもの

✅ キー識別子の押下回数 (例: `KeyA = 1234`, `Space = 567`)
✅ マウスボタン (左 / 中 / 右) のクリック回数
✅ 時間帯別 (0〜23 時) の活動量
✅ 日付ごとの集計

### 記録されないもの

❌ 入力された文字列・パスワード
❌ キー入力の順序やタイミング
❌ アクティブなアプリケーション名・ウィンドウタイトル
❌ スクリーンショット・画面の内容
❌ デバイス情報・IP アドレス・アカウント情報

### データの保存場所

| OS | パス |
| --- | --- |
| Windows | `%APPDATA%\Clack\data.json`<br>`%APPDATA%\Clack\settings.json` |
| macOS | `~/Library/Application Support/Clack/data.json`<br>`~/Library/Application Support/Clack/settings.json` |

ご自身で確認できます。`grep -r "http" src-tauri/src` でゼロ件であることを直接検証可能です。

---

## データ形式

`data.json` のスキーマ例:

```json
{
  "2026-05-15": {
    "keys": 8742,
    "mouse": 1124,
    "keyBreakdown": { "KeyA": 312, "Space": 421, "Return": 88 },
    "mouseBreakdown": { "Left": 980, "Right": 124, "Middle": 20 },
    "hourly": [0, 0, 0, 12, 88, 145, 410, 622, 803, ...]
  }
}
```

エクスポート CSV の列構成:

```
date,keys,mouse,total,h0,h1,h2,...,h23
2026-05-15,8742,1124,9866,0,0,0,12,88,...
```

---

## ビルド (ソースから)

詳細は **[RUN.md](RUN.md)** を参照してください。最短手順:

```sh
git clone https://github.com/YOUR-USERNAME/clack.git
cd clack
npm install
npm run build              # OS に応じた成果物を生成
```

| OS | 生成物 |
| --- | --- |
| Windows | `clack.exe` + `WebView2Loader.dll` + `Clack_*_x64-setup.exe` + `Clack_*_x64_en-US.msi` |
| macOS | `Clack_*_aarch64.dmg` / `Clack_*_universal.dmg` |

成果物は **すべて `dist/` フォルダに集約** されます。

### 配布 (Windows + macOS インストーラの自動生成)

タグ `v*.*.*` を push すると GitHub Actions が両 OS のインストーラを自動ビルドして Releases に添付します。手順は **[公開手順.md](公開手順.md) §4** を参照。

```sh
git tag v0.1.0
git push --follow-tags
# 10〜15 分で Releases ページに .exe / .msi / .dmg が並ぶ
```

---

## 技術スタック

| 層 | 採用 | 役割 |
| --- | --- | --- |
| アプリ枠 | [Tauri 2](https://tauri.app) | デスクトップ統合 / ウィンドウ管理 / IPC |
| WebView | OS 標準 (Win: WebView2 / Mac: WKWebView) | フロント描画 |
| バックエンド | [Rust](https://www.rust-lang.org) | 計数ロジック・状態管理・永続化 |
| 入力フック | [rdev 0.5](https://github.com/Narsil/rdev) | OS グローバルキー / マウスイベント (cross-platform) |
| 日時 | [time 0.3](https://github.com/time-rs/time) | ローカル日付・時刻処理 |
| 設定保存 | serde + JSON | atomic write (tmp → rename) |
| フロント | Vanilla JS + CSS | フレームワーク無依存 |
| 自動起動 | tauri-plugin-autostart | Win: レジストリ / Mac: LaunchAgent |
| ダイアログ | tauri-plugin-dialog | OS ネイティブファイル選択 |
| 二重起動防止 | tauri-plugin-single-instance | 起動ロック |
| 配布バンドル | tauri-bundler | Win: NSIS / MSI ・ Mac: .app / .dmg |

---

## アーキテクチャ

```
                     ┌────────────────────────┐
   OS 入力イベント   │  rdev リスナースレッド  │
   (kbd / mouse) ──→ │  handle_event           │
                     └──────┬─────────────────┘
                            │  Mutex<AppState>
                            ▼
       ┌─────────────────────────────────────────┐
       │  AppState                                │
       │   today_stats / history / hourly / ...   │
       └──┬───────────────────────────────────┬───┘
          │                                   │
   ┌──────▼─────────┐                ┌────────▼────────┐
   │ flush (10s)    │                │ rollover (30s)  │
   │ data.json 書込 │                │ 日付変更検知    │
   └────────────────┘                └─────────────────┘
                            │
                            ▼
                  ┌──────────────────────┐
                  │  WebView (JS UI)     │
                  │  invoke / listen     │
                  └──────────────────────┘
```

---

## 貢献

- バグ報告 / 機能要望は [Issues](https://github.com/YOUR-USERNAME/clack/issues) へ
- Pull Request も歓迎します
- コーディング規約は `src/main.js` 冒頭のセキュリティ方針コメント、Rust 側は `Cargo.toml` の `lints` 設定をご参照ください

---

## ライセンス

[MIT License](LICENSE) © Clack contributors

---

## 謝辞

- [Tauri](https://tauri.app) — Rust + WebView の薄いラッパー
- [rdev](https://github.com/Narsil/rdev) — クロスプラットフォームな入力フック
- インスピレーション元: GitHub Contribution Graph

---

<div align="center">

[⬆ トップへ戻る](#clack)

</div>
# Clack
