// SPDX-License-Identifier: MIT
//! macOS privacy prompts for global input monitoring.

/// Ask macOS for Input Monitoring permission when it is not already granted.
///
/// `rdev` uses a CoreGraphics event tap. On macOS 10.15+, mouse events may be
/// delivered while keyboard events are withheld until the app is allowed under
/// Privacy & Security -> Input Monitoring. In addition, `rdev` expects the app
/// to be trusted for Accessibility access to observe global key events.
#[cfg(target_os = "macos")]
pub fn request_input_monitoring() {
    use macos_accessibility_client::accessibility::application_is_trusted_with_prompt;
    use objc2_core_graphics::{CGPreflightListenEventAccess, CGRequestListenEventAccess};

    let accessibility_allowed = application_is_trusted_with_prompt();
    if !accessibility_allowed {
        eprintln!(
            "accessibility permission is not granted; keyboard events may not be counted",
        );
    }

    let already_allowed = CGPreflightListenEventAccess();
    if already_allowed {
        return;
    }

    let granted = CGRequestListenEventAccess();
    if !granted {
        eprintln!(
            "input monitoring permission is not granted; keyboard events may not be counted",
        );
    }
}

#[cfg(not(target_os = "macos"))]
pub fn request_input_monitoring() {}
