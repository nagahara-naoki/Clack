// SPDX-License-Identifier: MIT
//! macOS privacy prompts for global input monitoring.

/// Ask macOS for Input Monitoring permission when it is not already granted.
///
/// `rdev` uses a CoreGraphics event tap. On macOS 10.15+, mouse events may be
/// delivered while keyboard events are withheld until the app is allowed under
/// Privacy & Security -> Input Monitoring.
#[cfg(target_os = "macos")]
pub fn has_input_monitoring() -> bool {
    use objc2_core_graphics::CGPreflightListenEventAccess;

    CGPreflightListenEventAccess()
}

#[cfg(target_os = "macos")]
pub fn request_input_monitoring() {
    use objc2_core_graphics::CGRequestListenEventAccess;

    if has_input_monitoring() {
        return;
    }

    let granted = CGRequestListenEventAccess();
    if !granted {
        eprintln!(
            "input monitoring permission is not granted; keyboard events may not be counted",
        );
    }
}

/// macOS 以外では入力フックに OS 側の許可が要らないため、常に許可扱い。
/// クロスプラットフォーム呼び出しの対称性のために残しているが、Windows
/// ビルドでは内部から呼ばれない (dead_code 警告を抑止)。
#[cfg(not(target_os = "macos"))]
#[allow(dead_code)]
pub fn has_input_monitoring() -> bool {
    true
}

#[cfg(not(target_os = "macos"))]
pub fn request_input_monitoring() {}
