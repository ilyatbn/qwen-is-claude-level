//! `tracing` setup.
//!
//! An invalid `GAME_LOG` fails fast with a clear message rather than silently
//! defaulting — a filter typo that quietly turns off the logs you are trying to read
//! is a bad afternoon. See `docs/61-logging-debug.md` §1.

use std::fmt;

use tracing_subscriber::EnvFilter;

/// The log targets in use across the server. Kept here so a task adding a new one
/// has an obvious place to register it, and so tests can assert the list.
pub const TARGETS: [&str; 8] = [
    "game::map",
    "game::sim",
    "game::net",
    "game::player",
    "game::items",
    "game::weapons",
    "game::effects",
    "game::round",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoggingError {
    pub filter: String,
    pub reason: String,
}

impl fmt::Display for LoggingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "GAME_LOG is `{}`, which is not a valid filter: {}. \
             Examples: `info`, `info,game::map=debug`, `warn,game::net=trace`. \
             Targets: {}.",
            self.filter,
            self.reason,
            TARGETS.join(", ")
        )
    }
}

impl std::error::Error for LoggingError {}

/// Validate a filter string without installing anything. Used by `init` and by
/// tests, so the failure path is exercised without touching global state.
pub fn parse_filter(filter: &str) -> Result<EnvFilter, LoggingError> {
    EnvFilter::try_new(filter).map_err(|e| LoggingError {
        filter: filter.to_string(),
        reason: e.to_string(),
    })
}

/// Install the global subscriber. Idempotent: a second call is a no-op rather than
/// a panic, so tests that each call it do not fight.
pub fn init(filter: &str) -> Result<(), LoggingError> {
    let env_filter = parse_filter(filter)?;
    let _ = tracing_subscriber::fmt()
        .with_env_filter(env_filter)
        .with_target(true)
        .with_level(true)
        .compact()
        .try_init();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_filters_parse() {
        for f in [
            "info",
            "warn",
            "info,game::map=debug",
            "warn,game::net=trace",
            "debug",
        ] {
            assert!(parse_filter(f).is_ok(), "{f} should parse");
        }
    }

    #[test]
    fn an_invalid_filter_is_an_error_not_a_default() {
        let err = parse_filter("info,game::map=notalevel").expect_err("must reject");
        assert_eq!(err.filter, "info,game::map=notalevel");
        // The message must tell the operator what to do about it.
        let msg = err.to_string();
        assert!(msg.contains("game::map"));
        assert!(msg.contains("Examples"));
    }

    #[test]
    fn init_is_idempotent() {
        assert!(init("info").is_ok());
        assert!(init("info").is_ok());
    }

    #[test]
    fn init_rejects_a_bad_filter() {
        assert!(init("=====").is_err());
    }
}
