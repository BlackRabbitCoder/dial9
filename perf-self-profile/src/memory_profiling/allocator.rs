//! `Dial9Allocator<A>` — a `GlobalAlloc` wrapper that feeds dial9's memory
//! profiler.

use super::profiler::{ACTIVE, MemoryProfilerInner};
use std::alloc::{GlobalAlloc, Layout};

/// Generic `GlobalAlloc` wrapper that feeds dial9's memory profiler.
///
/// This type is designed to be installed as the process-global allocator
/// via `#[global_allocator]`. Used in any other context (e.g. as a local
/// allocator in `Box::new_in`) it will not enable memory profiling because
/// the hook only intercepts allocations that route through the global
/// allocator slot.
///
/// Defaults to wrapping `std::alloc::System`. Use `Dial9Allocator::system()`
/// (no turbofish) for the common case, or `Dial9Allocator::new(inner)` to
/// wrap a custom allocator like `tikv_jemallocator::Jemalloc` or
/// `mimalloc::MiMalloc`.
///
/// # Examples
///
/// Wrap the system allocator:
///
/// ```no_run
/// use dial9_perf_self_profile::memory_profiling::Dial9Allocator;
///
/// #[global_allocator]
/// static ALLOC: Dial9Allocator = Dial9Allocator::system();
/// # fn main() {}
/// ```
///
/// Wrap a custom allocator:
///
/// ```ignore
/// use dial9_perf_self_profile::memory_profiling::Dial9Allocator;
///
/// #[global_allocator]
/// static ALLOC: Dial9Allocator<tikv_jemallocator::Jemalloc> =
///     Dial9Allocator::new(tikv_jemallocator::Jemalloc);
/// ```
///
/// # Cost
///
/// Until [`MemoryProfiler::install()`](super::MemoryProfiler::install) has
/// been called, this checks the profiler state and forwards directly to the
/// inner allocator. The profiling path's stack frame stays in a separate
/// function. After install, allocations check a per-thread sampling counter;
/// stack capture and event emission run separately only when a sample fires.
/// Liveset tracking adds a lookup on each free. Costs depend on the allocator,
/// allocation sizes, and configured sampling interval.
#[derive(Debug)]
pub struct Dial9Allocator<A = std::alloc::System>(A);

impl Dial9Allocator {
    /// Wrap the system allocator.
    ///
    /// Use this when you don't need a custom inner allocator (i.e. you
    /// weren't otherwise setting `#[global_allocator]`).
    pub const fn system() -> Self {
        Self(std::alloc::System)
    }
}

impl<A: GlobalAlloc> Dial9Allocator<A> {
    /// Wrap a custom inner allocator (e.g. jemalloc, mimalloc).
    pub const fn new(inner: A) -> Self {
        Self(inner)
    }

    // Keep enabled dispatch separate so inactive calls can tail-call the inner
    // allocator. These helpers are hot after install; only actual samples are cold.
    #[inline(never)]
    unsafe fn alloc_profiled(&self, inner: &MemoryProfilerInner, layout: Layout) -> *mut u8 {
        // SAFETY: `layout` validity contract forwarded to the inner allocator.
        let ptr = unsafe { self.0.alloc(layout) };
        // SAFETY: the hook guards reentrant liveset operations (see hook module
        // docs). `ptr` is non-null (checked below) and valid.
        if !ptr.is_null() {
            crate::memory_profiling::hook::on_alloc(inner, ptr, layout.size());
        }
        ptr
    }

    #[inline(never)]
    unsafe fn dealloc_profiled(&self, inner: &MemoryProfilerInner, ptr: *mut u8, layout: Layout) {
        // SAFETY: the hook guards reentrant liveset operations (see hook module
        // docs). `ptr` is valid per the `dealloc` contract.
        crate::memory_profiling::hook::on_dealloc(inner, ptr, layout.size());
        // SAFETY: `ptr`/`layout` validity contract forwarded to the inner
        // allocator.
        unsafe { self.0.dealloc(ptr, layout) };
    }

    #[inline(never)]
    unsafe fn realloc_profiled(
        &self,
        inner: &MemoryProfilerInner,
        ptr: *mut u8,
        old_layout: Layout,
        new_size: usize,
    ) -> *mut u8 {
        // The old block's liveset entry must come out BEFORE forwarding to
        // the inner allocator: `self.0.realloc` may release `ptr` internally,
        // after which another thread can be handed that address and overwrite
        // the entry. Resolving it afterwards would pop the new allocation's
        // metadata instead. See `hook::ReallocState`.
        //
        // SAFETY: the hook guards reentrant liveset operations (see hook module
        // docs). `ptr` is valid per the `realloc` contract.
        let state = crate::memory_profiling::hook::on_realloc_before(inner, ptr);
        // SAFETY: `ptr`/`old_layout`/`new_size` validity contract forwarded
        // to the inner allocator.
        let new_ptr = unsafe { self.0.realloc(ptr, old_layout, new_size) };
        // SAFETY: both hooks preserve the reentrancy guard (see hook module docs).
        if new_ptr.is_null() {
            // Realloc failed: the old pointer is still live and must not
            // be recorded as freed (design §3, "realloc handling").
            crate::memory_profiling::hook::on_realloc_failed(inner, ptr, state);
        } else {
            crate::memory_profiling::hook::on_realloc_success(inner, ptr, state, new_ptr, new_size);
        }
        new_ptr
    }

    #[inline(never)]
    unsafe fn alloc_zeroed_profiled(&self, inner: &MemoryProfilerInner, layout: Layout) -> *mut u8 {
        // SAFETY: forwarded to the inner allocator.
        let ptr = unsafe { self.0.alloc_zeroed(layout) };
        // SAFETY: the hook guards reentrant liveset operations (see hook module
        // docs). `ptr` is non-null (checked below) and valid.
        if !ptr.is_null() {
            crate::memory_profiling::hook::on_alloc(inner, ptr, layout.size());
        }
        ptr
    }
}

// SAFETY: forwarding to the inner `GlobalAlloc` impl. The `unsafe` contract on
// each method is exactly the same as the inner allocator's. Hooks preserve
// their reentrancy guards across liveset operations — see
// [`crate::memory_profiling::hook`] module docs and design §6.
unsafe impl<A: GlobalAlloc> GlobalAlloc for Dial9Allocator<A> {
    #[inline]
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // Sample profiler state at entry so the inactive path can tail-call the
        // inner allocator without retaining its result for a later hook.
        match ACTIVE.get() {
            // SAFETY: valid layout; the helper preserves the hook contract.
            Some(inner) => unsafe { self.alloc_profiled(inner, layout) },
            // SAFETY: forwarded from the caller.
            None => unsafe { self.0.alloc(layout) },
        }
    }

    // Inlining this dispatch regressed the demo-trace decoder on x86_64.
    #[inline(never)]
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        match ACTIVE.get() {
            // SAFETY: ptr/layout are valid; the hook runs before the inner free.
            Some(inner) if inner.liveset.is_some() => unsafe {
                self.dealloc_profiled(inner, ptr, layout)
            },
            // SAFETY: forwarded from the caller; frees need no hook without a liveset.
            _ => unsafe { self.0.dealloc(ptr, layout) },
        }
    }

    #[inline]
    unsafe fn realloc(&self, ptr: *mut u8, old_layout: Layout, new_size: usize) -> *mut u8 {
        match ACTIVE.get() {
            // SAFETY: the helper removes liveset metadata before realloc and
            // restores it on failure, while forwarding the caller's contract.
            Some(inner) => unsafe { self.realloc_profiled(inner, ptr, old_layout, new_size) },
            // SAFETY: forwarded from the caller.
            None => unsafe { self.0.realloc(ptr, old_layout, new_size) },
        }
    }

    #[inline]
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        match ACTIVE.get() {
            // SAFETY: valid layout; the helper preserves the hook contract.
            Some(inner) => unsafe { self.alloc_zeroed_profiled(inner, layout) },
            // SAFETY: forwarded from the caller.
            None => unsafe { self.0.alloc_zeroed(layout) },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::alloc::{GlobalAlloc, Layout};

    #[test]
    fn dial9_allocator_default_constructible() {
        let _: Dial9Allocator = Dial9Allocator::system();
    }

    #[test]
    fn dial9_allocator_alloc_dealloc_roundtrip() {
        let allocator = Dial9Allocator::system();
        let layout = Layout::from_size_align(1024, 8).unwrap();
        // SAFETY: layout is valid; we own the returned pointer.
        let ptr = unsafe { allocator.alloc(layout) };
        assert!(!ptr.is_null(), "alloc returned null");
        // Touch the memory to make sure it's writable.
        unsafe { ptr.write_bytes(0x42, 1024) };
        // SAFETY: `ptr` was just allocated with this `layout`.
        unsafe { allocator.dealloc(ptr, layout) };
    }

    #[test]
    fn dial9_allocator_alloc_zeroed_returns_zero() {
        let allocator = Dial9Allocator::system();
        let layout = Layout::from_size_align(1024, 8).unwrap();
        // SAFETY: layout is valid.
        let ptr = unsafe { allocator.alloc_zeroed(layout) };
        assert!(!ptr.is_null(), "alloc_zeroed returned null");
        let slice = unsafe { std::slice::from_raw_parts(ptr, 1024) };
        assert!(
            slice.iter().all(|&b| b == 0),
            "alloc_zeroed memory not zeroed"
        );
        // SAFETY: `ptr` was allocated with this `layout`.
        unsafe { allocator.dealloc(ptr, layout) };
    }

    #[test]
    fn dial9_allocator_realloc_grows() {
        let allocator = Dial9Allocator::system();
        let layout = Layout::from_size_align(64, 8).unwrap();
        // SAFETY: layout is valid.
        let ptr = unsafe { allocator.alloc(layout) };
        assert!(!ptr.is_null(), "initial alloc returned null");
        unsafe { ptr.write_bytes(0xAB, 64) };
        // SAFETY: ptr was allocated with `layout`, new_size (256) > 0.
        let new_ptr = unsafe { allocator.realloc(ptr, layout, 256) };
        assert!(!new_ptr.is_null(), "realloc returned null");
        // Verify original bytes preserved.
        let slice = unsafe { std::slice::from_raw_parts(new_ptr, 64) };
        assert!(
            slice.iter().all(|&b| b == 0xAB),
            "realloc didn't preserve data"
        );
        // Write to the grown region.
        unsafe { new_ptr.add(64).write_bytes(0xCD, 192) };
        // SAFETY: new_ptr was returned by realloc with new_size=256.
        let new_layout = Layout::from_size_align(256, 8).unwrap();
        unsafe { allocator.dealloc(new_ptr, new_layout) };
    }

    #[test]
    fn dial9_allocator_with_custom_inner_compiles() {
        let allocator = Dial9Allocator::new(std::alloc::System);
        let layout = Layout::from_size_align(128, 8).unwrap();
        // SAFETY: layout is valid.
        let ptr = unsafe { allocator.alloc(layout) };
        assert!(!ptr.is_null(), "alloc returned null");
        // SAFETY: ptr was allocated with this layout.
        unsafe { allocator.dealloc(ptr, layout) };
    }
}
