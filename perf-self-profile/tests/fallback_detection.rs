#![cfg(all(
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
))]

use dial9_perf_self_profile::{
    EventSource, PerfSampler, SamplerConfig, SamplingMode, is_ctimer_active,
};

// libc doesn't re-export AUDIT_ARCH_*, see include/uapi/linux/audit.h.
#[cfg(target_arch = "x86_64")]
const AUDIT_ARCH: u32 = 0xC000_003E;
#[cfg(target_arch = "aarch64")]
const AUDIT_ARCH: u32 = 0xC000_00B7;

fn stmt(code: u16, k: u32) -> libc::sock_filter {
    libc::sock_filter {
        code,
        jt: 0,
        jf: 0,
        k,
    }
}
fn jump(code: u16, k: u32, jt: u8, jf: u8) -> libc::sock_filter {
    libc::sock_filter { code, jt, jf, k }
}

// Seccomp BPF: return EACCES for perf_event_open, allow everything else.
// PR_SET_NO_NEW_PRIVS lets us install the filter without CAP_SYS_ADMIN.
fn install_seccomp_blocking_perf_event_open() {
    let ld_abs = (libc::BPF_LD | libc::BPF_W | libc::BPF_ABS) as u16;
    let jeq = (libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K) as u16;
    let ret = (libc::BPF_RET | libc::BPF_K) as u16;

    // seccomp_data offsets: nr @ 0, arch @ 4.
    let filter = [
        stmt(ld_abs, 4),
        jump(jeq, AUDIT_ARCH, 0, 3),
        stmt(ld_abs, 0),
        jump(jeq, libc::SYS_perf_event_open as u32, 0, 1),
        stmt(ret, libc::SECCOMP_RET_ERRNO | libc::EACCES as u32),
        stmt(ret, libc::SECCOMP_RET_ALLOW),
    ];
    let prog = libc::sock_fprog {
        len: filter.len() as u16,
        filter: filter.as_ptr() as *mut _,
    };

    unsafe {
        assert_eq!(libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0), 0);
        assert_eq!(
            libc::prctl(
                libc::PR_SET_SECCOMP,
                libc::SECCOMP_MODE_FILTER as libc::c_ulong,
                &prog as *const _ as libc::c_ulong,
                0,
                0,
            ),
            0
        );
    }
}

/// Raw self-profile probe. Returns true if the kernel lets us open a
/// minimal perf event on the calling task.
fn perf_event_open_works() -> bool {
    // perf_event_attr: type=PERF_TYPE_SOFTWARE (1), size=128,
    // config=PERF_COUNT_SW_CPU_CLOCK (0). Rest zeroed.
    let mut attr: [u8; 128] = [0; 128];
    attr[0] = 1;
    attr[4..8].copy_from_slice(&128u32.to_le_bytes());
    let fd = unsafe {
        libc::syscall(
            libc::SYS_perf_event_open,
            attr.as_ptr(),
            0i32,  // pid = self
            0i32,  // cpu = 0
            -1i32, // group_fd
            0u64,  // flags
        )
    };
    if fd >= 0 {
        unsafe { libc::close(fd as i32) };
        true
    } else {
        false
    }
}

#[test]
fn uses_perf_path_when_available() {
    if !perf_event_open_works() {
        eprintln!("skipping: perf_event_open blocked in this env");
        return;
    }

    let _sampler = PerfSampler::start(
        SamplerConfig::default()
            .event_source(EventSource::SwCpuClock)
            .sampling(SamplingMode::FrequencyHz(999)),
    )
    .expect("PerfSampler::start should succeed when perf is available");

    assert!(
        !is_ctimer_active(),
        "dispatcher routed to ctimer despite perf being available"
    );
}

/// Run `child` in a forked process and assert it returned `true`. Forked
/// tests keep the seccomp filter (sticky) and process-wide ctimer state out of
/// the rest of the test run.
fn in_fork(what: &str, child: impl FnOnce() -> bool) {
    let pid = unsafe { libc::fork() };
    assert!(pid >= 0, "fork failed");
    if pid == 0 {
        // A panic must not unwind into the forked copy of the test harness.
        let code = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(child)) {
            Ok(true) => 0,
            Ok(false) => 1,
            Err(_) => 2,
        };
        unsafe { libc::_exit(code) };
    }
    let mut status = 0;
    assert_eq!(unsafe { libc::waitpid(pid, &mut status, 0) }, pid);
    assert!(libc::WIFEXITED(status), "child did not exit normally");
    match libc::WEXITSTATUS(status) {
        0 => {}
        2 => panic!("child panicked, see its stderr"),
        _ => panic!("{what}"),
    }
}

#[test]
fn falls_back_to_ctimer_when_perf_event_open_blocked() {
    in_fork("fallback did not trigger", || {
        install_seccomp_blocking_perf_event_open();
        let sampler = PerfSampler::start(
            SamplerConfig::default()
                .event_source(EventSource::SwCpuClock)
                .sampling(SamplingMode::FrequencyHz(999)),
        );
        sampler.is_ok() && is_ctimer_active()
    });
}

/// The `Auto` backend reports ctimer when perf is blocked: the path production
/// takes, as opposed to forcing ctimer.
#[cfg(feature = "cpu-profiling")]
#[test]
fn auto_backend_reports_ctimer_when_perf_event_open_blocked() {
    use dial9_perf_self_profile::{ActiveCpuBackend, CpuProfiler, CpuProfilingConfig};

    in_fork("Auto did not report ctimer", || {
        install_seccomp_blocking_perf_event_open();
        CpuProfiler::start(CpuProfilingConfig::default())
            .is_ok_and(|p| matches!(p.active_backend(), ActiveCpuBackend::Ctimer { .. }))
    });
}

/// Another profiler's ctimer doesn't make a perf profiler report ctimer.
/// Forked: ctimer is process-wide.
#[cfg(feature = "cpu-profiling")]
#[test]
fn auto_reports_perf_while_another_profiler_runs_ctimer() {
    use dial9_perf_self_profile::{ActiveCpuBackend, CpuProfiler, CpuProfilingConfig};

    if !perf_event_open_works() {
        eprintln!("skipping: perf_event_open blocked in this env");
        return;
    }
    in_fork("Auto on perf reported ctimer", || {
        let Ok(_ctimer) = CpuProfiler::start(CpuProfilingConfig::with_ctimer_backend()) else {
            return false;
        };
        CpuProfiler::start(CpuProfilingConfig::default())
            .is_ok_and(|p| matches!(p.active_backend(), ActiveCpuBackend::Perf { .. }))
    });
}

/// With perf blocked, `with_cpu_profiling` (perf backend) and
/// `with_sched_events` register `StartFailed` placeholders. Both errors say
/// how to allow `perf_event_open`.
#[cfg(feature = "cpu-profiling")]
#[test]
fn failed_profilers_register_placeholders_when_perf_event_open_blocked() {
    use dial9_core::buffer::MemoryBuffer;
    use dial9_core::recorder::recorder;
    use dial9_perf_self_profile::{
        CpuProfiler, CpuProfilingConfig, RecorderPerfExt, SchedEventConfig, SchedProfiler,
        StartFailed,
    };

    in_fork("placeholders missing or without the perf hint", || {
        install_seccomp_blocking_perf_event_open();
        let rec = recorder(MemoryBuffer::new(64 * 1024).expect("writer"))
            .with_cpu_profiling(CpuProfilingConfig::with_perf_backend())
            .with_sched_events(SchedEventConfig::default())
            .build();
        let h = rec.handle();
        let ok = h
            .with_source(|f: &mut StartFailed<CpuProfiler>| f.message().to_string())
            .is_some_and(|m| m.contains("CAP_PERFMON"))
            && h.with_source(|f: &mut StartFailed<SchedProfiler>| f.message().to_string())
                .is_some_and(|m| m.contains("perf_event_paranoid"))
            && h.with_source(|_: &mut CpuProfiler| ()).is_none()
            && h.with_source(|_: &mut SchedProfiler| ()).is_none();
        rec.graceful_shutdown(std::time::Duration::ZERO);
        ok
    });
}
