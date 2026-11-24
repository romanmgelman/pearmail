//! "Downloading Messages – 14 of 231": one running count of message downloads across every
//! account and connection, sent to the UI as `download-progress` { done, total }.
//!
//! Each download takes a [`Job`] for the messages it's about to fetch and ticks it off chunk
//! by chunk; a job dropped early (error, cancel) counts its remainder as done, so the total
//! always settles. When everything is done the count resets to 0 / 0.

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

static APP: OnceLock<AppHandle> = OnceLock::new();
static STATE: Mutex<Counts> = Mutex::new(Counts { done: 0, total: 0, last_emit: None });

struct Counts {
    done: usize,
    total: usize,
    last_emit: Option<Instant>,
}

#[derive(Clone, serde::Serialize)]
struct Progress {
    done: usize,
    total: usize,
}

const EMIT_EVERY: Duration = Duration::from_millis(150);

pub fn init(app: AppHandle) {
    let _ = APP.set(app);
}

/// Messages a download is fetching. See the module docs.
pub struct Job {
    left: usize,
}

impl Job {
    pub fn start(n: usize) -> Job {
        if n > 0 {
            update(|c| c.total += n);
        }
        Job { left: n }
    }

    /// `k` more of this job's messages have arrived.
    pub fn add(&mut self, k: usize) {
        let k = k.min(self.left);
        if k > 0 {
            self.left -= k;
            update(|c| c.done += k);
        }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        let k = self.left;
        self.add(k);
    }
}

fn update(f: impl FnOnce(&mut Counts)) {
    let snapshot = {
        let mut c = STATE.lock().unwrap();
        let idle = c.total == 0;
        f(&mut c);
        let finished = c.done >= c.total;
        if finished {
            c.done = 0;
            c.total = 0;
        }
        // Throttled, except the start and the finish (which the UI must always see).
        let due = idle || finished || c.last_emit.map(|t| t.elapsed() >= EMIT_EVERY).unwrap_or(true);
        if !due {
            return;
        }
        c.last_emit = Some(Instant::now());
        Progress { done: c.done, total: c.total }
    };
    if let Some(app) = APP.get() {
        let _ = app.emit("download-progress", snapshot);
    }
}

#[cfg(test)]
pub(crate) fn counts() -> (usize, usize) {
    let c = STATE.lock().unwrap();
    (c.done, c.total)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Jobs running at once add up, and the count resets once all of them are done,
    /// including one that ended early.
    #[test]
    fn jobs_sum_and_settle() {
        let mut a = Job::start(10);
        let mut b = Job::start(5);
        assert_eq!(counts(), (0, 15));
        a.add(4);
        b.add(5);
        assert_eq!(counts(), (9, 15));
        a.add(100); // never more than the job had
        assert_eq!(counts(), (0, 0));
        drop(a);
        drop(b);
        let c = Job::start(3);
        assert_eq!(counts(), (0, 3));
        drop(c); // ended early: its remainder counts as done
        assert_eq!(counts(), (0, 0));
        drop(Job::start(0));
        assert_eq!(counts(), (0, 0));
    }
}
