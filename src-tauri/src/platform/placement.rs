//! Window placement persistence and recovery (T27).
//!
//! The window adapter stores a small JSON document with the logical window
//! rectangle and the name of the monitor it was on. On startup the rectangle
//! is clamped to a monitor work area before it is applied, so a window can
//! never reopen fully outside the screen after a monitor is unplugged.
//!
//! Placement is best effort by design:
//!
//! * A malformed or unreadable document is ignored and the window keeps its
//!   default placement. It is never treated as an error worth a warning.
//! * Write errors are ignored. The timer must keep working even when the data
//!   directory is read-only; the only loss is the remembered position.
//! * Wayland compositors own the placement of ordinary windows. On Wayland
//!   `set_position` is at most a hint that the compositor may ignore, so the
//!   saved coordinates are not a promise there. Keep the keyboard "Restore
//!   window" action working as the reliable path.
//!
//! The file is written with a temporary file in the same directory followed
//! by a rename, so a crash never leaves a half-written document.

// `restore_placement` and `install_placement_tracking` are the entry points
// that `lib.rs` setup has to call. That file is owned by the integrator, so
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Runtime, WindowEvent};

use super::window::{MAIN_WINDOW_LABEL, MIN_HEIGHT, MIN_WIDTH, NORMAL_HEIGHT, NORMAL_WIDTH};

/// File name of the placement document inside the application data directory.
pub const PLACEMENT_FILE: &str = "window-placement.json";

/// Schema version of the placement document.
pub const SCHEMA_VERSION: u32 = 1;

/// The shortest interval between two writes while the user drags the window.
const SAVE_INTERVAL: Duration = Duration::from_millis(500);

/// A rectangle in logical pixels.
///
/// The origin is the top-left corner of the primary monitor or, on multi
/// monitor desktops, the top-left corner of the virtual screen. Negative
/// origins are normal and must be preserved, not treated as invalid.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub const fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    /// Whether the rectangle has a finite, positive size.
    pub fn is_usable(self) -> bool {
        self.width.is_finite() && self.height.is_finite() && self.width > 0.0 && self.height > 0.0
    }

    /// The centre of the rectangle.
    pub fn centre(self) -> (f64, f64) {
        (self.x + self.width / 2.0, self.y + self.height / 2.0)
    }

    /// Whether a point lies inside the rectangle.
    pub fn contains(self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.x + self.width && y >= self.y && y < self.y + self.height
    }
}

/// The on-disk placement document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedPlacement {
    pub schema_version: u32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// Monitor name when the desktop exposes one. On X11 this is often
    /// missing, in which case the rectangle itself decides the monitor.
    #[serde(default)]
    pub monitor: Option<String>,
}

impl SavedPlacement {
    fn from_rect(rect: Rect, monitor: Option<String>) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            monitor,
        }
    }

    fn rect(&self) -> Rect {
        Rect::new(self.x, self.y, self.width, self.height)
    }
}

/// A monitor with its work area in logical pixels.
#[derive(Debug, Clone, PartialEq)]
pub struct MonitorArea {
    pub name: Option<String>,
    pub area: Rect,
}

/// Reads a placement document. Malformed documents, unknown schema versions
/// and non-finite rectangles are ignored.
fn parse_document(raw: &str) -> Option<SavedPlacement> {
    let saved: SavedPlacement = serde_json::from_str(raw).ok()?;
    if saved.schema_version != SCHEMA_VERSION {
        return None;
    }
    Some(saved)
}

/// Converts a physical rectangle to logical pixels with a guarded scale
/// factor. A missing or nonsensical scale factor is treated as 1.
pub fn logical_rect(x: i32, y: i32, width: u32, height: u32, scale: f64) -> Rect {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    Rect::new(
        f64::from(x) / scale,
        f64::from(y) / scale,
        f64::from(width) / scale,
        f64::from(height) / scale,
    )
}

/// Clamps a window rectangle so that it lies inside a monitor work area.
///
/// The rules:
///
/// * A rectangle larger than the work area shrinks to the work area.
/// * A rectangle that starts before the work area (a negative origin on a
///   monitor to the left or above the primary one) keeps its relative
///   position; only coordinates outside the work area move.
/// * A rectangle that is fully outside the work area moves back inside; it is
///   never restored fully off-screen.
/// * The compact size is untouched when it fits the work area.
/// * A non-finite or non-positive size falls back to the smallest practical
///   window, so a corrupt value cannot create an invisible window.
pub fn clamp_to_work_area(rect: Rect, work_area: Rect) -> Rect {
    if !work_area.is_usable() {
        return rect;
    }
    let width = clamp_dimension(rect.width, work_area.width, MIN_WIDTH);
    let height = clamp_dimension(rect.height, work_area.height, MIN_HEIGHT);
    Rect {
        x: clamp_origin(rect.x, work_area.x, work_area.width, width),
        y: clamp_origin(rect.y, work_area.y, work_area.height, height),
        width,
        height,
    }
}

/// Centres a window of the given size in a work area, shrinking it when the
/// monitor cannot hold it.
pub fn centred_in(work_area: Rect, width: f64, height: f64) -> Rect {
    if !work_area.is_usable() {
        return Rect::new(work_area.x, work_area.y, width, height);
    }
    let width = clamp_dimension(width, work_area.width, MIN_WIDTH);
    let height = clamp_dimension(height, work_area.height, MIN_HEIGHT);
    Rect::new(
        work_area.x + (work_area.width - width) / 2.0,
        work_area.y + (work_area.height - height) / 2.0,
        width,
        height,
    )
}

fn clamp_dimension(value: f64, available: f64, minimum: f64) -> f64 {
    let smallest = minimum.min(available);
    if !value.is_finite() || value <= 0.0 {
        return smallest;
    }
    value.max(smallest).min(available)
}

fn clamp_origin(value: f64, origin: f64, available: f64, size: f64) -> f64 {
    if !value.is_finite() {
        return origin;
    }
    let last = origin + (available - size).max(0.0);
    value.max(origin).min(last)
}

/// Chooses the work area a saved rectangle belongs to.
///
/// The monitor name wins when the desktop still reports it. When the named
/// monitor is gone the primary monitor is used, never the removed monitor's
/// old coordinates. Without a name, the monitor under the rectangle's centre
/// is used. `primary` is passed separately because some desktops do not mark
/// the primary monitor in the list.
pub fn select_work_area(
    saved_monitor: Option<&str>,
    rect: Rect,
    monitors: &[MonitorArea],
    primary: Option<Rect>,
) -> Option<Rect> {
    let fallback = primary.filter(|area| area.is_usable()).or_else(|| {
        monitors
            .iter()
            .map(|monitor| monitor.area)
            .find(|area| area.is_usable())
    })?;

    if let Some(name) = saved_monitor.filter(|name| !name.is_empty()) {
        return Some(
            monitors
                .iter()
                .find(|monitor| monitor.name.as_deref() == Some(name))
                .map_or(fallback, |monitor| monitor.area),
        );
    }

    let (x, y) = rect.centre();
    Some(
        monitors
            .iter()
            .find(|monitor| monitor.area.contains(x, y))
            .map_or(fallback, |monitor| monitor.area),
    )
}

/// The placement used by "Restore defaults": the normal size centred on the
/// primary monitor, or the normal size at the origin when no monitor is
/// reported.
pub fn default_placement<R: Runtime>(app: &AppHandle<R>) -> Rect {
    match primary_work_area(app) {
        Some(area) => centred_in(area, NORMAL_WIDTH, NORMAL_HEIGHT),
        None => Rect::new(0.0, 0.0, NORMAL_WIDTH, NORMAL_HEIGHT),
    }
}

/// The work area of the primary monitor in logical pixels.
pub fn primary_work_area<R: Runtime>(app: &AppHandle<R>) -> Option<Rect> {
    let monitor = app.primary_monitor().ok().flatten()?;
    Some(monitor_rect(&monitor))
}

fn monitor_rect(monitor: &tauri::Monitor) -> Rect {
    let scale = monitor.scale_factor();
    let work = monitor.work_area();
    let area = logical_rect(
        work.position.x,
        work.position.y,
        work.size.width,
        work.size.height,
        scale,
    );
    if area.is_usable() {
        return area;
    }
    // Some desktops report an empty work area. The monitor bounds are a safe
    // approximation, even though panels may overlap the window.
    let size = monitor.size();
    let position = monitor.position();
    logical_rect(position.x, position.y, size.width, size.height, scale)
}

fn monitor_areas<R: Runtime>(app: &AppHandle<R>) -> Vec<MonitorArea> {
    let Ok(monitors) = app.available_monitors() else {
        return Vec::new();
    };
    monitors
        .iter()
        .map(|monitor| MonitorArea {
            name: monitor.name().cloned(),
            area: monitor_rect(monitor),
        })
        .collect()
}

fn placement_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|directory| directory.join(PLACEMENT_FILE))
}

fn load<R: Runtime>(app: &AppHandle<R>) -> Option<SavedPlacement> {
    let path = placement_path(app)?;
    let raw = fs::read_to_string(path).ok()?;
    parse_document(&raw)
}

/// Writes a document through a temporary file and a rename.
///
/// Windows refuses to rename over an existing file, so a failed rename falls
/// back to removing the stale file once. Placement is not durable user data;
/// failures stay silent on purpose.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, bytes)?;
    match fs::rename(&temporary, path) {
        Ok(()) => Ok(()),
        Err(error) => {
            if path.exists() {
                fs::remove_file(path)?;
                fs::rename(&temporary, path)
            } else {
                let _ = fs::remove_file(&temporary);
                Err(error)
            }
        }
    }
}

/// Stores the current window rectangle.
///
/// Write failures are ignored: remembering the position is a convenience and
/// never a reason to interrupt the timer.
pub fn save_current<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.inner_size() else {
        return;
    };
    let rect = logical_rect(
        position.x,
        position.y,
        size.width,
        size.height,
        window.scale_factor().unwrap_or(1.0),
    );
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .and_then(|monitor| monitor.name().cloned());
    let Ok(bytes) = serde_json::to_vec_pretty(&SavedPlacement::from_rect(rect, monitor)) else {
        return;
    };
    if let Some(path) = placement_path(app) {
        let _ = write_atomic(&path, &bytes);
    }
}

/// Forgets the remembered placement.
///
/// Used by "Restore defaults" so the next start cannot reopen the rectangle
/// the user just reset, and so a corrupt document is removed rather than
/// read again.
pub fn forget<R: Runtime>(app: &AppHandle<R>) {
    if let Some(path) = placement_path(app) {
        let _ = fs::remove_file(path);
    }
}

/// Restores the remembered rectangle on startup.
///
/// The saved rectangle is clamped to the work area of its monitor. When that
/// monitor is gone the primary monitor is used instead. A missing, unreadable
/// or malformed document leaves the window untouched. On Wayland the
/// compositor may ignore the position request; it owns the placement of
/// ordinary windows, so this can only be a hint.
pub fn restore_placement<R: Runtime>(app: &AppHandle<R>) {
    let Some(saved) = load(app) else {
        return;
    };
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    let monitors = monitor_areas(app);
    let primary = primary_work_area(app);
    let Some(work_area) =
        select_work_area(saved.monitor.as_deref(), saved.rect(), &monitors, primary)
    else {
        return;
    };
    let rect = clamp_to_work_area(saved.rect(), work_area);
    let _ = window.set_size(LogicalSize::new(rect.width, rect.height));
    let _ = window.set_position(LogicalPosition::new(rect.x, rect.y));
}

/// Starts remembering the placement after the user moves or resizes the
/// window.
///
/// This registers a window-local listener, so `lib.rs` only has to call it
/// once during setup:
///
/// ```ignore
/// platform::window::install_placement_tracking(&handle);
/// ```
///
/// Moves and resizes are written at most once every 500ms. The final position
/// is written when the close is requested or the window is destroyed. This
/// keeps a drag from writing hundreds of files while still saving the result
/// if the application quits immediately after the drag.
pub fn install_placement_tracking<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    let last_save: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));
    let pending = Arc::new(AtomicBool::new(false));
    let handle = app.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            save_throttled(&handle, &last_save, &pending);
        }
        // A close may be prevented (the window is only hidden), so the final
        // save also runs here rather than only on destroy.
        WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed => {
            save_current(&handle);
        }
        _ => {}
    });
}

fn save_throttled<R: Runtime>(
    app: &AppHandle<R>,
    last_save: &Arc<Mutex<Option<Instant>>>,
    pending: &Arc<AtomicBool>,
) {
    let now = Instant::now();
    let due = match last_save.lock() {
        Ok(mut last) => {
            let due = last.is_none_or(|at| now.duration_since(at) >= SAVE_INTERVAL);
            if due {
                *last = Some(now);
            }
            due
        }
        // A poisoned mutex only means another save panicked; writing again is
        // harmless.
        Err(_) => true,
    };
    if due {
        save_current(app);
        return;
    }

    // A throttled event still has to reach the file. Schedule one trailing
    // write instead of blocking this event or writing on every pixel.
    if pending.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    let last_save = Arc::clone(last_save);
    let pending = Arc::clone(pending);
    std::thread::spawn(move || {
        std::thread::sleep(SAVE_INTERVAL);
        if let Ok(mut last) = last_save.lock() {
            *last = Some(Instant::now());
        }
        save_current(&app);
        pending.store(false, Ordering::Release);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn primary() -> Rect {
        Rect::new(0.0, 0.0, 1920.0, 1080.0)
    }

    #[test]
    fn clamps_a_rectangle_with_a_negative_origin() {
        let rect = Rect::new(-400.0, -300.0, 320.0, 200.0);
        let clamped = clamp_to_work_area(rect, primary());
        assert_eq!(clamped, Rect::new(0.0, 0.0, 320.0, 200.0));
    }

    #[test]
    fn keeps_a_negative_origin_that_belongs_to_a_monitor_on_the_left() {
        let left_monitor = Rect::new(-1920.0, 0.0, 1920.0, 1080.0);
        let rect = Rect::new(-1800.0, 100.0, 320.0, 200.0);
        assert_eq!(clamp_to_work_area(rect, left_monitor), rect);
    }

    #[test]
    fn shrinks_a_rectangle_larger_than_the_monitor() {
        let rect = Rect::new(0.0, 0.0, 3000.0, 2000.0);
        let clamped = clamp_to_work_area(rect, primary());
        assert_eq!(clamped, primary());
    }

    #[test]
    fn preserves_the_compact_size_when_it_fits() {
        let rect = Rect::new(100.0, 100.0, 320.0, 200.0);
        assert_eq!(clamp_to_work_area(rect, primary()), rect);
    }

    #[test]
    fn moves_a_rectangle_that_is_fully_off_screen_back_inside() {
        let rect = Rect::new(9000.0, 9000.0, 420.0, 440.0);
        let clamped = clamp_to_work_area(rect, primary());
        assert_eq!(clamped, Rect::new(1500.0, 640.0, 420.0, 440.0));
        assert!(primary().contains(clamped.x, clamped.y));
    }

    #[test]
    fn a_fitting_rectangle_keeps_its_offset_between_monitors() {
        let rect = Rect::new(1920.0 + 50.0, 40.0, 420.0, 440.0);
        let right_monitor = Rect::new(1920.0, 0.0, 2560.0, 1440.0);
        assert_eq!(clamp_to_work_area(rect, right_monitor), rect);
    }

    #[test]
    fn replaces_non_finite_and_zero_sizes_with_a_usable_size() {
        let rect = Rect::new(f64::NAN, 10.0, 0.0, f64::INFINITY);
        let clamped = clamp_to_work_area(rect, primary());
        assert_eq!(clamped.width, MIN_WIDTH);
        assert_eq!(clamped.height, MIN_HEIGHT);
        assert_eq!(clamped.x, 0.0);
        assert_eq!(clamped.y, 10.0);
    }

    #[test]
    fn an_unusable_work_area_leaves_the_rectangle_alone() {
        let rect = Rect::new(10.0, 20.0, 320.0, 200.0);
        assert_eq!(
            clamp_to_work_area(rect, Rect::new(0.0, 0.0, 0.0, 0.0)),
            rect
        );
    }

    #[test]
    fn restores_on_the_primary_monitor_when_the_saved_monitor_is_gone() {
        let monitors = vec![MonitorArea {
            name: Some("eDP-1".to_string()),
            area: primary(),
        }];
        let rect = Rect::new(-1500.0, 300.0, 320.0, 200.0);
        let area = select_work_area(Some("DP-2"), rect, &monitors, Some(primary()))
            .expect("the primary monitor is a fallback");
        assert_eq!(area, primary());
        let clamped = clamp_to_work_area(rect, area);
        assert!(primary().contains(clamped.x, clamped.y));
        assert_eq!(clamped.width, 320.0);
        assert_eq!(clamped.height, 200.0);
    }

    #[test]
    fn uses_the_named_monitor_when_it_still_exists() {
        let right = Rect::new(1920.0, 0.0, 2560.0, 1440.0);
        let monitors = vec![
            MonitorArea {
                name: Some("eDP-1".to_string()),
                area: primary(),
            },
            MonitorArea {
                name: Some("DP-2".to_string()),
                area: right,
            },
        ];
        let rect = Rect::new(2000.0, 100.0, 420.0, 440.0);
        assert_eq!(
            select_work_area(Some("DP-2"), rect, &monitors, Some(primary())),
            Some(right)
        );
    }

    #[test]
    fn without_a_name_uses_the_monitor_under_the_rectangle() {
        let right = Rect::new(1920.0, 0.0, 2560.0, 1440.0);
        let monitors = vec![
            MonitorArea {
                name: None,
                area: primary(),
            },
            MonitorArea {
                name: None,
                area: right,
            },
        ];
        let rect = Rect::new(2500.0, 100.0, 420.0, 440.0);
        assert_eq!(
            select_work_area(None, rect, &monitors, Some(primary())),
            Some(right)
        );
    }

    #[test]
    fn without_monitors_falls_back_to_the_primary_monitor() {
        let rect = Rect::new(10.0, 10.0, 420.0, 440.0);
        assert_eq!(
            select_work_area(None, rect, &[], Some(primary())),
            Some(primary())
        );
        assert_eq!(select_work_area(None, rect, &[], None), None);
    }

    #[test]
    fn centring_keeps_the_window_inside_the_monitor() {
        let placement = centred_in(primary(), NORMAL_WIDTH, NORMAL_HEIGHT);
        assert_eq!(placement.width, NORMAL_WIDTH);
        assert_eq!(placement.height, NORMAL_HEIGHT);
        assert_eq!(placement.x, (1920.0 - NORMAL_WIDTH) / 2.0);
        assert_eq!(placement.y, (1080.0 - NORMAL_HEIGHT) / 2.0);
    }

    #[test]
    fn centring_shrinks_a_window_larger_than_the_monitor() {
        let tiny = Rect::new(0.0, 0.0, 300.0, 200.0);
        let placement = centred_in(tiny, NORMAL_WIDTH, NORMAL_HEIGHT);
        assert_eq!(placement.width, 300.0);
        assert_eq!(placement.height, 200.0);
        assert_eq!(placement, tiny);
    }

    #[test]
    fn converts_physical_pixels_to_logical_pixels() {
        assert_eq!(
            logical_rect(0, 0, 3840, 2160, 2.0),
            Rect::new(0.0, 0.0, 1920.0, 1080.0)
        );
        assert_eq!(
            logical_rect(-1920, 0, 1920, 1080, 1.0),
            Rect::new(-1920.0, 0.0, 1920.0, 1080.0)
        );
        // A broken scale factor must not produce an infinite rectangle.
        assert_eq!(
            logical_rect(0, 0, 800, 600, 0.0),
            Rect::new(0.0, 0.0, 800.0, 600.0)
        );
    }

    #[test]
    fn a_saved_placement_round_trips_through_json() {
        let saved = SavedPlacement::from_rect(
            Rect::new(-20.0, 40.0, 320.0, 200.0),
            Some("DP-2".to_string()),
        );
        let raw = serde_json::to_string(&saved).expect("the document is serializable");
        assert!(raw.contains("\"schemaVersion\":1"));
        assert!(raw.contains("\"monitor\":\"DP-2\""));
        assert_eq!(parse_document(&raw), Some(saved));
    }

    #[test]
    fn malformed_and_future_documents_are_ignored() {
        assert_eq!(parse_document(""), None);
        assert_eq!(parse_document("not json"), None);
        assert_eq!(parse_document("{\"schemaVersion\":1}"), None);
        assert_eq!(
            parse_document(
                "{\"schemaVersion\":99,\"x\":0,\"y\":0,\"width\":320,\"height\":200,\"monitor\":null}"
            ),
            None
        );
    }

    #[test]
    fn a_document_without_a_monitor_name_is_accepted() {
        let raw = "{\"schemaVersion\":1,\"x\":0,\"y\":0,\"width\":320,\"height\":200}";
        let saved = parse_document(raw).expect("the monitor name is optional");
        assert_eq!(saved.monitor, None);
        assert_eq!(saved.rect(), Rect::new(0.0, 0.0, 320.0, 200.0));
    }
}
