//! Configuration, read once from the environment at startup.
//!
//! Every value fails **loudly** on a bad input rather than silently defaulting.
//! `MAP_SCALE=huge` should say what it got and what is allowed, then exit — a
//! server that quietly runs a different map than you asked for wastes an afternoon.
//!
//! See `docs/41-server-loop-rooms.md` §5.

use std::env;
use std::fmt;
use std::net::SocketAddr;

use game_core::constants::MapScale;
use game_core::constants::{
    BOT_COUNT_DEFAULT, BOT_SKILL_DEFAULT, DEFAULT_MAP_SCALE, MAX_PLAYERS, MIN_PLAYERS_TO_START,
    ROUND_SECONDS,
};

#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    pub bind_addr: SocketAddr,
    pub game_log: String,
    pub map_scale: MapScale,
    pub max_players: usize,
    pub round_seconds: f32,
    pub min_players_to_start: usize,
    pub fixed_seed: Option<u64>,
    pub record_replay: bool,
    pub debug_dump: bool,
    /// v2 (`docs/70-amendments-v2.md` §A5)
    pub bot_count: usize,
    pub bot_skill: f32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError {
    pub var: &'static str,
    pub value: String,
    pub expected: String,
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} is `{}`, which is not valid. Expected {}.",
            self.var, self.value, self.expected
        )
    }
}

impl std::error::Error for ConfigError {}

impl Default for Config {
    fn default() -> Self {
        Config {
            bind_addr: ([0, 0, 0, 0], 3000).into(),
            game_log: "info".to_string(),
            map_scale: DEFAULT_MAP_SCALE,
            max_players: MAX_PLAYERS,
            round_seconds: ROUND_SECONDS,
            min_players_to_start: MIN_PLAYERS_TO_START,
            fixed_seed: None,
            record_replay: false,
            debug_dump: false,
            bot_count: BOT_COUNT_DEFAULT,
            bot_skill: BOT_SKILL_DEFAULT,
        }
    }
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_source(|k| env::var(k).ok())
    }

    /// The whole parser, with the environment injected — so it is testable without
    /// mutating the real process environment, which is a race in a threaded test
    /// runner.
    pub fn from_source(get: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let d = Config::default();

        let bind_addr = match get("BIND_ADDR") {
            Some(v) => v.parse::<SocketAddr>().map_err(|_| ConfigError {
                var: "BIND_ADDR",
                value: v.clone(),
                expected: "a socket address such as 0.0.0.0:3000".to_string(),
            })?,
            None => d.bind_addr,
        };

        let game_log = get("GAME_LOG").unwrap_or(d.game_log);

        let map_scale = match get("MAP_SCALE") {
            Some(v) => MapScale::parse(&v).ok_or_else(|| ConfigError {
                var: "MAP_SCALE",
                value: v.clone(),
                expected: "one of: small, medium, large".to_string(),
            })?,
            None => d.map_scale,
        };

        let max_players = parse_usize(&get, "MAX_PLAYERS", d.max_players, 1, MAX_PLAYERS)?;
        let min_players_to_start = parse_usize(
            &get,
            "MIN_PLAYERS_TO_START",
            d.min_players_to_start,
            1,
            MAX_PLAYERS,
        )?;

        let round_seconds = match get("ROUND_SECONDS") {
            Some(v) => {
                let n = v.parse::<f32>().map_err(|_| ConfigError {
                    var: "ROUND_SECONDS",
                    value: v.clone(),
                    expected: "a positive number of seconds".to_string(),
                })?;
                if !(n.is_finite() && n > 0.0) {
                    return Err(ConfigError {
                        var: "ROUND_SECONDS",
                        value: v,
                        expected: "a positive number of seconds".to_string(),
                    });
                }
                n
            }
            None => d.round_seconds,
        };

        let fixed_seed = match get("FIXED_SEED") {
            // An empty value means "unset" — compose writes `FIXED_SEED=` when the
            // .env variable is blank, and that must not be a parse error.
            Some(v) if v.trim().is_empty() => None,
            Some(v) => Some(v.trim().parse::<u64>().map_err(|_| ConfigError {
                var: "FIXED_SEED",
                value: v.clone(),
                expected: "an unsigned 64-bit integer, or empty for a random seed".to_string(),
            })?),
            None => None,
        };

        let record_replay = parse_bool(&get, "RECORD_REPLAY", d.record_replay)?;
        let debug_dump = parse_bool(&get, "DEBUG_DUMP", d.debug_dump)?;

        let bot_count = parse_usize(&get, "BOT_COUNT", d.bot_count, 0, MAX_PLAYERS)?;
        let bot_skill = match get("BOT_SKILL") {
            Some(v) => {
                let n = v.parse::<f32>().map_err(|_| ConfigError {
                    var: "BOT_SKILL",
                    value: v.clone(),
                    expected: "a number from 0.0 to 1.0".to_string(),
                })?;
                if !(n.is_finite() && (0.0..=1.0).contains(&n)) {
                    return Err(ConfigError {
                        var: "BOT_SKILL",
                        value: v,
                        expected: "a number from 0.0 to 1.0".to_string(),
                    });
                }
                n
            }
            None => d.bot_skill,
        };

        Ok(Config {
            bind_addr,
            game_log,
            map_scale,
            max_players,
            round_seconds,
            min_players_to_start,
            fixed_seed,
            record_replay,
            debug_dump,
            bot_count,
            bot_skill,
        })
    }

    /// One line, `key=value`, for the startup log (`docs/61-logging-debug.md` §2).
    pub fn summary(&self) -> String {
        format!(
            "bind={} scale={} max_players={} round_seconds={} min_players={} \
             fixed_seed={} record_replay={} debug_dump={} bots={} bot_skill={}",
            self.bind_addr,
            self.map_scale.as_str(),
            self.max_players,
            self.round_seconds,
            self.min_players_to_start,
            self.fixed_seed
                .map(|s| s.to_string())
                .unwrap_or_else(|| "random".to_string()),
            self.record_replay,
            self.debug_dump,
            self.bot_count,
            self.bot_skill,
        )
    }
}

fn parse_usize(
    get: &impl Fn(&str) -> Option<String>,
    var: &'static str,
    default: usize,
    lo: usize,
    hi: usize,
) -> Result<usize, ConfigError> {
    let expected = || format!("an integer from {lo} to {hi}");
    match get(var) {
        Some(v) => {
            let n = v.trim().parse::<usize>().map_err(|_| ConfigError {
                var,
                value: v.clone(),
                expected: expected(),
            })?;
            if !(lo..=hi).contains(&n) {
                return Err(ConfigError {
                    var,
                    value: v,
                    expected: expected(),
                });
            }
            Ok(n)
        }
        None => Ok(default),
    }
}

fn parse_bool(
    get: &impl Fn(&str) -> Option<String>,
    var: &'static str,
    default: bool,
) -> Result<bool, ConfigError> {
    match get(var) {
        Some(v) => match v.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Ok(true),
            "0" | "false" | "no" | "off" | "" => Ok(false),
            _ => Err(ConfigError {
                var,
                value: v,
                expected: "one of: 0, 1, true, false".to_string(),
            }),
        },
        None => Ok(default),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty(_: &str) -> Option<String> {
        None
    }

    fn from(pairs: &[(&str, &str)]) -> Result<Config, ConfigError> {
        let owned: Vec<(String, String)> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        Config::from_source(|k| {
            owned
                .iter()
                .find(|(key, _)| key == k)
                .map(|(_, v)| v.clone())
        })
    }

    #[test]
    fn clean_environment_gives_documented_defaults() {
        let c = Config::from_source(empty).expect("defaults must parse");
        assert_eq!(c.bind_addr.to_string(), "0.0.0.0:3000");
        assert_eq!(c.game_log, "info");
        // v2: the default scale is Large, not Medium.
        assert_eq!(c.map_scale, MapScale::Large);
        assert_eq!(c.max_players, 6);
        assert_eq!(c.round_seconds, 240.0);
        assert_eq!(c.min_players_to_start, 1);
        assert_eq!(c.fixed_seed, None);
        assert!(!c.record_replay);
        assert!(!c.debug_dump);
        assert_eq!(c.bot_count, 3);
    }

    #[test]
    fn invalid_map_scale_names_the_bad_value() {
        let err = from(&[("MAP_SCALE", "huge")]).expect_err("must reject");
        assert_eq!(err.var, "MAP_SCALE");
        assert_eq!(err.value, "huge");
        assert!(err.expected.contains("small"));
        assert!(err.to_string().contains("huge"));
    }

    #[test]
    fn valid_map_scales_are_accepted() {
        for (s, expect) in [
            ("small", MapScale::Small),
            ("medium", MapScale::Medium),
            ("LARGE", MapScale::Large),
        ] {
            let c = from(&[("MAP_SCALE", s)]).expect("valid scale");
            assert_eq!(c.map_scale, expect);
        }
    }

    #[test]
    fn invalid_bind_addr_is_rejected() {
        let err = from(&[("BIND_ADDR", "not-an-address")]).expect_err("must reject");
        assert_eq!(err.var, "BIND_ADDR");
    }

    #[test]
    fn empty_fixed_seed_means_unset_not_an_error() {
        // docker compose writes `FIXED_SEED=` for a blank .env value.
        assert_eq!(
            from(&[("FIXED_SEED", "")]).expect("blank ok").fixed_seed,
            None
        );
        assert_eq!(
            from(&[("FIXED_SEED", "  ")]).expect("blank ok").fixed_seed,
            None
        );
        assert_eq!(
            from(&[("FIXED_SEED", "8123491234")])
                .expect("numeric ok")
                .fixed_seed,
            Some(8_123_491_234)
        );
        assert!(from(&[("FIXED_SEED", "abc")]).is_err());
    }

    #[test]
    fn out_of_range_numbers_are_rejected() {
        assert!(from(&[("MAX_PLAYERS", "0")]).is_err());
        assert!(from(&[("MAX_PLAYERS", "7")]).is_err());
        assert!(from(&[("ROUND_SECONDS", "0")]).is_err());
        assert!(from(&[("ROUND_SECONDS", "-5")]).is_err());
        assert!(from(&[("BOT_SKILL", "1.5")]).is_err());
        assert!(from(&[("BOT_COUNT", "9")]).is_err());
        // In range.
        assert_eq!(
            from(&[("ROUND_SECONDS", "5")]).expect("ok").round_seconds,
            5.0
        );
        assert_eq!(from(&[("BOT_COUNT", "0")]).expect("ok").bot_count, 0);
    }

    #[test]
    fn booleans_accept_the_usual_spellings() {
        for v in ["1", "true", "TRUE", "yes", "on"] {
            assert!(
                from(&[("RECORD_REPLAY", v)]).expect("ok").record_replay,
                "{v}"
            );
        }
        for v in ["0", "false", "no", "off", ""] {
            assert!(!from(&[("DEBUG_DUMP", v)]).expect("ok").debug_dump, "{v}");
        }
        assert!(from(&[("DEBUG_DUMP", "maybe")]).is_err());
    }

    #[test]
    fn summary_is_one_line_of_key_values() {
        let s = Config::from_source(empty).expect("ok").summary();
        assert!(!s.contains('\n'));
        assert!(s.contains("scale=large"));
        assert!(s.contains("fixed_seed=random"));
    }
}
