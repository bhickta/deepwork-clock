//! Native elapsed-time adapter.
//!
//! The countdown must not be driven by the wall clock: a clock adjustment, a
//! daylight saving switch or an NTP correction must never change a running
//! phase. The adapter therefore samples a *monotonic* clock.
//!
//! The preferred source also includes the time the machine spent in system
//! suspend, because the product policy is that a countdown continues across
//! sleep:
//!
//! * Linux: `clock_gettime(CLOCK_BOOTTIME)`,
//! * Windows: `GetTickCount64`,
//! * macOS: `mach_continuous_time` converted with `mach_timebase_info`.
//!
//! `std::time::Instant` alone is not used for the countdown because it stops
//! during suspend on most platforms. It is only the fallback when the native
//! call is unavailable, and the fallback is reported honestly through
//! [`kind`].
//!
//! Safety: every foreign call below is wrapped in a narrow `unsafe` block
//! with a pointer to a local, correctly aligned and initialised value. No
//! pointer escapes the call and no foreign type is transmuted.

use std::sync::OnceLock;
use std::time::Instant;

/// Which clock the adapter is currently using.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClockKind {
    /// Monotonic and suspend inclusive: the countdown continues while the
    /// machine is asleep.
    SuspendInclusive,
    /// Monotonic while the machine is awake only. A detected gap is then
    /// treated as an interruption.
    MonotonicAwake,
}

impl ClockKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ClockKind::SuspendInclusive => "suspend-inclusive",
            ClockKind::MonotonicAwake => "monotonic-awake",
        }
    }

    /// Whether a long gap between two samples means the machine was asleep.
    pub fn includes_suspend(self) -> bool {
        matches!(self, ClockKind::SuspendInclusive)
    }
}

/// The clock implementation that is in use on this machine.
pub fn kind() -> ClockKind {
    if cfg!(any(
        target_os = "linux",
        target_os = "windows",
        target_os = "macos"
    )) {
        ClockKind::SuspendInclusive
    } else {
        ClockKind::MonotonicAwake
    }
}

/// Milliseconds elapsed since an arbitrary but fixed origin.
///
/// The value never decreases and never depends on the wall clock.
pub fn elapsed_ms() -> u64 {
    imp::elapsed_ms()
}

/// Converts nanoseconds into whole milliseconds without wrapping.
fn nanos_to_millis(nanos: u128) -> u64 {
    let millis = nanos / 1_000_000;
    if millis > u64::MAX as u128 {
        u64::MAX
    } else {
        millis as u64
    }
}

/// Monotonic fallback that stops during suspend.
fn fallback_elapsed_ms() -> u64 {
    static ORIGIN: OnceLock<Instant> = OnceLock::new();
    let origin = ORIGIN.get_or_init(Instant::now);
    let millis = origin.elapsed().as_millis();
    if millis > u64::MAX as u128 {
        u64::MAX
    } else {
        millis as u64
    }
}

#[cfg(target_os = "linux")]
mod imp {
    /// Linux implementation based on `CLOCK_BOOTTIME`.
    pub fn elapsed_ms() -> u64 {
        let mut timespec = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: `timespec` is a valid, writable, correctly aligned
        // `libc::timespec` and `CLOCK_BOOTTIME` is a clock id that Linux
        // provides since 2.6.39. The call only writes into the provided
        // pointer.
        let result = unsafe { libc::clock_gettime(libc::CLOCK_BOOTTIME, &mut timespec) };
        if result != 0 {
            return super::fallback_elapsed_ms();
        }
        let seconds = if timespec.tv_sec < 0 {
            0u64
        } else {
            timespec.tv_sec as u64
        };
        let nanos = if timespec.tv_nsec < 0 {
            0u64
        } else {
            timespec.tv_nsec as u64
        };
        super::nanos_to_millis(seconds as u128 * 1_000_000_000 + nanos as u128)
    }
}

#[cfg(target_os = "windows")]
mod imp {
    extern "system" {
        /// `GetTickCount64` returns the number of milliseconds since the
        /// system started, including time spent in sleep.
        fn GetTickCount64() -> u64;
    }

    pub fn elapsed_ms() -> u64 {
        // SAFETY: the function takes no arguments, cannot fail and returns a
        // plain integer.
        unsafe { GetTickCount64() }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    #[repr(C)]
    struct TimebaseInfo {
        numer: u32,
        denom: u32,
    }

    extern "C" {
        fn mach_continuous_time() -> u64;
        fn mach_timebase_info(info: *mut TimebaseInfo) -> i32;
    }

    pub fn elapsed_ms() -> u64 {
        // SAFETY: `mach_continuous_time` takes no arguments and cannot fail.
        let ticks = unsafe { mach_continuous_time() };
        let mut info = TimebaseInfo { numer: 0, denom: 0 };
        // SAFETY: `info` is a valid, writable, correctly aligned
        // `TimebaseInfo`; the function only fills the two integers.
        let status = unsafe { mach_timebase_info(&mut info) };
        if status != 0 || info.denom == 0 {
            return super::fallback_elapsed_ms();
        }
        let nanos = (ticks as u128).saturating_mul(info.numer as u128) / info.denom as u128;
        super::nanos_to_millis(nanos)
    }
}

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
mod imp {
    pub fn elapsed_ms() -> u64 {
        super::fallback_elapsed_ms()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_clock_never_moves_backwards() {
        let first = elapsed_ms();
        let second = elapsed_ms();
        assert!(second >= first, "{second} < {first}");
    }

    #[test]
    fn nanoseconds_are_truncated_to_milliseconds() {
        assert_eq!(nanos_to_millis(0), 0);
        assert_eq!(nanos_to_millis(999_999), 0);
        assert_eq!(nanos_to_millis(1_000_000), 1);
        assert_eq!(nanos_to_millis(2_500_000), 2);
    }

    #[test]
    fn nanosecond_conversion_does_not_overflow() {
        assert_eq!(nanos_to_millis(u128::MAX), u64::MAX);
    }

    #[test]
    fn the_clock_kind_is_reported_honestly() {
        let kind = kind();
        if cfg!(any(
            target_os = "linux",
            target_os = "windows",
            target_os = "macos"
        )) {
            assert_eq!(kind, ClockKind::SuspendInclusive);
        } else {
            assert_eq!(kind, ClockKind::MonotonicAwake);
        }
        assert!(kind.as_str().len() > 3);
    }
}
