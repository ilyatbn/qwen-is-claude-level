//! T23.37 item 2: **the build id a replay header carries** (`replay::BUILD_ID`) — the
//! commit this server was built from, so a replay that diverges can say which build made
//! it and `replay --verify` can warn when it is not the running one.
//!
//! `git rev-parse --short=12 HEAD`, plus `+dirty` when the tree had uncommitted changes
//! under `crates/` at build time (the simulation's sources; a dirty client changes no
//! replay). No git (a tarball, a container without `.git`): `unknown`. Rebuilt when
//! HEAD or the ref it points at moves.

use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn main() {
    let sha = git(&["rev-parse", "--short=12", "HEAD"]);
    let dirty =
        git(&["status", "--porcelain", "--", "../../crates"]).is_some_and(|s| !s.is_empty());
    let id = match sha {
        Some(s) if dirty => format!("{s}+dirty"),
        Some(s) => s,
        None => "unknown".to_string(),
    };
    println!("cargo:rustc-env=SHRED_BUILD_ID={id}");
    for path in ["HEAD", "index"] {
        if let Some(p) = git(&["rev-parse", "--git-path", path]) {
            println!("cargo:rerun-if-changed={p}");
        }
    }
    if let Some(r) = git(&["symbolic-ref", "-q", "HEAD"]) {
        if let Some(p) = git(&["rev-parse", "--git-path", &r]) {
            println!("cargo:rerun-if-changed={p}");
        }
    }
    println!("cargo:rerun-if-changed=build.rs");
}
