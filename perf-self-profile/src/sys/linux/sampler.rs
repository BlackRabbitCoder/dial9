//! Public `PerfSampler`, dispatch layer over perf and ctimer backends.
//!
//! Attempts to use `perf_event_open` first. If blocked (e.g. kernel restrictions),
//! falls back to ctimer-based sampling with userspace frame-pointer unwinding.

use std::io;

use super::ctimer_sampler::CtimerSampler;
use super::perf_sampler::{PerfSamplerImpl, excludes_kernel};
use crate::sampler::{ActiveCpuBackend, EventSource, Sample, SamplerConfig};

pub(super) trait SamplerBackend: Send {
    fn track_current_thread(&mut self) -> io::Result<()>;
    fn stop_tracking_current_thread(&mut self);
    fn has_pending(&self) -> bool;
    fn for_each_sample(&mut self, f: &mut dyn FnMut(&Sample));
    fn drain_samples(&mut self) -> Vec<Sample>;
    fn disable(&self);
    fn enable(&self);
    fn backend(&self) -> ActiveCpuBackend;
}

/// CPU sampler dispatching to perf_event_open or ctimer (fallback).
pub struct PerfSampler {
    inner: Box<dyn SamplerBackend>,
}

impl std::fmt::Debug for PerfSampler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PerfSampler").finish_non_exhaustive()
    }
}

/// `"; <how to allow it>"` when `err` says `perf_event_open` was denied, else
/// `""`. Names the highest `perf_event_paranoid` that opens `config`'s events.
/// Tracepoints get none: they can need `perf_event_paranoid` -1, which lets
/// every user on the host read raw tracepoint data.
fn enable_perf_hint(err: &io::Error, config: &SamplerConfig) -> &'static str {
    if !matches!(err.raw_os_error(), Some(libc::EACCES | libc::EPERM)) {
        return "";
    }
    match config.event_source {
        EventSource::Tracepoint(_) => {
            "; to enable it, grant CAP_PERFMON (before Linux 5.8, the broader \
             CAP_SYS_ADMIN) or allow perf_event_open in the container's seccomp profile"
        }
        _ if excludes_kernel(config) => {
            "; to enable it, grant CAP_PERFMON (before Linux 5.8, the broader \
             CAP_SYS_ADMIN), allow perf_event_open in the container's seccomp profile, \
             or set kernel.perf_event_paranoid to 2"
        }
        _ => {
            "; to enable it, grant CAP_PERFMON (before Linux 5.8, the broader \
             CAP_SYS_ADMIN), allow perf_event_open in the container's seccomp profile, \
             or set kernel.perf_event_paranoid to 1, which lets every user on the host \
             profile the kernel"
        }
    }
}

/// Returns `true` if the error indicates `perf_event_open` is blocked by
/// the kernel (seccomp, perf_event_paranoid, missing syscall).
pub(crate) fn is_perf_blocked(err: &io::Error) -> bool {
    matches!(
        err.raw_os_error(),
        Some(libc::EACCES) | Some(libc::EPERM) | Some(libc::ENOSYS) | Some(libc::EOPNOTSUPP)
    )
}

impl PerfSampler {
    /// Start sampling the current process.
    ///
    /// Tries perf first, falls back to ctimer if `perf_event_open` is blocked.
    /// Also respects the `DIAL9_FORCE_CTIMER` environment variable.
    pub fn start(config: SamplerConfig) -> io::Result<Self> {
        Self::start_for_pid(0, config)
    }

    /// Start sampling using only the perf backend. No ctimer fallback.
    ///
    /// Returns an error if `perf_event_open` is blocked or fails for any reason.
    /// A denied open's error says how to allow it.
    #[cfg(feature = "cpu-profiling")]
    pub(crate) fn start_perf_only(config: SamplerConfig) -> io::Result<Self> {
        let perf =
            PerfSamplerImpl::start_for_pid(0, &config).map_err(|e| {
                match enable_perf_hint(&e, &config) {
                    "" => e,
                    hint => {
                        io::Error::new(e.kind(), format!("perf_event_open blocked ({e}){hint}"))
                    }
                }
            })?;
        Ok(Self {
            inner: Box::new(perf),
        })
    }

    /// Start sampling using only the ctimer backend. No perf attempt.
    ///
    /// Only supports frequency-based sampling. Returns an error for
    /// period-based configurations.
    #[cfg(feature = "cpu-profiling")]
    pub(crate) fn start_ctimer_only(config: SamplerConfig) -> io::Result<Self> {
        Self::ctimer_fallback(&config)
    }

    /// Start sampling a specific process.
    ///
    /// `pid=0` means the current process. `pid=-1` means all processes (requires root).
    pub fn start_for_pid(pid: i32, config: SamplerConfig) -> io::Result<Self> {
        use crate::SamplingMode;

        if std::env::var_os("DIAL9_FORCE_CTIMER").is_some() {
            match config.sampling {
                SamplingMode::FrequencyHz(_) => {
                    tracing::info!("DIAL9_FORCE_CTIMER set, using ctimer-based CPU profiling");
                    return Self::ctimer_fallback(&config);
                }
                SamplingMode::Period(_) => {
                    tracing::warn!(
                        "DIAL9_FORCE_CTIMER set but ignored: ctimer only supports \
                         frequency-based sampling, not period-based"
                    );
                }
            }
        }

        match PerfSamplerImpl::start_for_pid(pid, &config) {
            Ok(perf) => Ok(Self {
                inner: Box::new(perf),
            }),
            Err(e) if is_perf_blocked(&e) => {
                if pid != 0 && pid != -1 {
                    tracing::warn!(
                        "ctimer fallback cannot profile pid {pid}, \
                         will sample current process only"
                    );
                }
                tracing::warn!(
                    "perf_event_open failed ({e}), falling back to ctimer-based \
                     CPU profiling (userspace frame-pointer unwinding)"
                );
                Self::ctimer_fallback(&config)
            }
            Err(e) => Err(e),
        }
    }

    /// Create a per-thread sampler with no initial threads.
    ///
    /// Falls back to ctimer for frequency-based sampling when perf is blocked.
    /// Event-based sampling (context switches, tracepoints) requires
    /// `perf_event_open` and cannot fall back — returns an error if blocked.
    pub fn new_per_thread(config: SamplerConfig) -> io::Result<Self> {
        use crate::SamplingMode;

        if std::env::var_os("DIAL9_FORCE_CTIMER").is_some() {
            match config.sampling {
                SamplingMode::FrequencyHz(_) => {
                    tracing::info!("DIAL9_FORCE_CTIMER set, using ctimer-based profiling");
                    return Self::with_ctimer(&config);
                }
                SamplingMode::Period(_) => {
                    tracing::warn!(
                        "DIAL9_FORCE_CTIMER set but ignored: ctimer only supports \
                         frequency-based sampling, not period-based"
                    );
                }
            }
        }

        match PerfSamplerImpl::new_per_thread(&config) {
            Ok(perf) => Ok(Self {
                inner: Box::new(perf),
            }),
            Err(e) if is_perf_blocked(&e) => match config.sampling {
                SamplingMode::FrequencyHz(_) => {
                    tracing::warn!(
                        "perf_event_open failed ({e}), falling back to ctimer-based \
                         profiling for per-thread mode"
                    );
                    Self::with_ctimer(&config)
                }
                SamplingMode::Period(_) => Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    format!(
                        "perf_event_open blocked ({e}) and event-based sampling \
                         has no userspace fallback (requires kernel support){}",
                        enable_perf_hint(&e, &config)
                    ),
                )),
            },
            Err(e) => Err(e),
        }
    }

    /// Create ctimer sampler with the right registration strategy.
    ///
    /// On Linux, registers the calling thread (process-wide mode).
    /// On Android, does NOT register the calling thread — the caller is
    /// typically the main JVM thread whose ART interpreter frames lack
    /// standard frame pointers, causing the unwinder to crash. Worker
    /// threads self-register via `register_current_thread()`.
    fn ctimer_fallback(config: &SamplerConfig) -> io::Result<Self> {
        #[cfg(target_os = "android")]
        {
            Self::with_ctimer(config)
        }
        #[cfg(target_os = "linux")]
        {
            Self::with_ctimer_process_wide(config)
        }
    }

    /// Create ctimer sampler without registering any threads (per-thread mode).
    fn with_ctimer(config: &SamplerConfig) -> io::Result<Self> {
        Ok(Self {
            inner: Box::new(CtimerSampler::start(config)?),
        })
    }

    /// Create ctimer sampler and register the calling thread (process-wide mode).
    #[cfg(target_os = "linux")]
    fn with_ctimer_process_wide(config: &SamplerConfig) -> io::Result<Self> {
        let mut sampler = Self::with_ctimer(config)?;
        sampler.track_current_thread()?;
        Ok(sampler)
    }

    pub fn track_current_thread(&mut self) -> io::Result<()> {
        self.inner.track_current_thread()
    }

    /// The backend this sampler runs on.
    pub fn backend(&self) -> ActiveCpuBackend {
        self.inner.backend()
    }

    pub fn stop_tracking_current_thread(&mut self) {
        self.inner.stop_tracking_current_thread()
    }

    pub fn has_pending(&self) -> bool {
        self.inner.has_pending()
    }

    pub fn for_each_sample<F: FnMut(&Sample)>(&mut self, mut f: F) {
        self.inner.for_each_sample(&mut f)
    }

    pub fn drain_samples(&mut self) -> Vec<Sample> {
        self.inner.drain_samples()
    }

    /// Pause collection. Reversible via `enable`.
    pub fn disable(&self) {
        self.inner.disable()
    }

    /// Resume collection after `disable`.
    pub fn enable(&self) {
        self.inner.enable()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A denied `perf_event_open` says how to allow it, with paranoid 2 for
    /// user-space-only events, 1 for the rest and none for tracepoints; a
    /// missing one doesn't.
    #[test]
    fn denied_perf_errors_say_how_to_enable_it() {
        use crate::SamplingMode;

        let ctxsw = SamplerConfig::default()
            .event_source(EventSource::SwContextSwitches)
            .sampling(SamplingMode::Period(1));
        let cpu = SamplerConfig::default()
            .event_source(EventSource::SwCpuClock)
            .sampling(SamplingMode::FrequencyHz(99));
        let cpu_kernel = cpu.clone().include_kernel(true);
        let tracepoint = SamplerConfig::default()
            .event_source(EventSource::Tracepoint(0))
            .sampling(SamplingMode::Period(1));
        for errno in [libc::EACCES, libc::EPERM] {
            let err = io::Error::from_raw_os_error(errno);
            for (config, level) in [(&ctxsw, "1,"), (&cpu, "2"), (&cpu_kernel, "1,")] {
                let hint = enable_perf_hint(&err, config);
                assert!(
                    hint.contains(&format!("perf_event_paranoid to {level}")),
                    "{errno}: {hint}"
                );
            }
            let hint = enable_perf_hint(&err, &tracepoint);
            assert!(hint.contains("CAP_PERFMON"), "{errno}: {hint}");
            assert!(!hint.contains("perf_event_paranoid"), "{errno}: {hint}");
        }
        for errno in [libc::ENOSYS, libc::EOPNOTSUPP] {
            let err = io::Error::from_raw_os_error(errno);
            assert_eq!(enable_perf_hint(&err, &ctxsw), "");
        }
    }

    #[test]
    fn is_perf_blocked_recognizes_blocked_errors() {
        for errno in [libc::EACCES, libc::EPERM, libc::ENOSYS, libc::EOPNOTSUPP] {
            let err = io::Error::from_raw_os_error(errno);
            assert!(
                is_perf_blocked(&err),
                "expected is_perf_blocked=true for errno {errno}"
            );
        }
    }

    #[test]
    fn is_perf_blocked_ignores_other_errors() {
        for errno in [libc::EINVAL, libc::ENOENT, libc::EBADF] {
            let err = io::Error::from_raw_os_error(errno);
            assert!(
                !is_perf_blocked(&err),
                "expected is_perf_blocked=false for errno {errno}"
            );
        }
    }
}
