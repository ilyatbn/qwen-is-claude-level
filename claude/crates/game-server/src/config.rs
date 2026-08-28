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

use game_core::constants::{MapGenerator, MapScale};
use game_core::constants::{
    BOT_COUNT_DEFAULT, BOT_SKILL_DEFAULT, DEFAULT_MAP_GENERATOR, DEFAULT_MAP_SCALE,
    LOBBY_BOT_TIMEOUT, MAX_PLAYERS, ROOM_EMPTY_TTL, ROUND_SECONDS,
};

#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    pub bind_addr: SocketAddr,
    pub game_log: String,
    pub map_scale: MapScale,
    /// Which terrain generator builds the round's map.
    ///
    /// Runtime rather than compile-time because the two are meant to be compared
    /// on the same box: `MAP_GENERATOR=v1` puts the old maps back without a
    /// rebuild. Safe to switch at runtime because the client is sent the finished
    /// mask in `map_init` and never regenerates it from the seed — only the
    /// sandbox and preview scenes call the generator, and they are local.
    pub map_generator: MapGenerator,
    pub max_players: usize,
    pub round_seconds: f32,
    /// Seconds after the last human leaves before the room is dropped (§B1).
    ///
    /// Configurable for the same reason `round_seconds` is: the end-to-end test
    /// that proves the sweep runs has to observe a room actually disappear, and
    /// a test that sleeps for the 30 s default is a test nobody runs.
    pub room_empty_ttl: f32,
    /// How long a public lobby waits before bots fill it and the match starts
    /// (`docs/74-amendments-v6.md` §E2).
    ///
    /// Configurable for exactly the reason `room_empty_ttl` is, and the loss it
    /// repairs is on the record: at the default 10 s a browser cannot observe
    /// the lobby at all, because a cold page — vite transform, wasm init, first
    /// frame — takes longer than that to reach `ready`. T17.07 measured ~0.0 s
    /// of waiting and had to retire the browser-level claim that you arrive in
    /// a lobby. A check can raise this and see it.
    pub lobby_bot_timeout: f32,
    pub fixed_seed: Option<u64>,
    pub record_replay: bool,
    /// Where `RECORD_REPLAY=1` writes. Configurable so a test can point at a
    /// scratch directory, and so an operator can put replays on a volume that
    /// is not the working directory (`docs/62` §4 bind-mounts one).
    pub replay_dir: String,
    pub debug_dump: bool,
    /// v2 (`docs/70-amendments-v2.md` §A5)
    pub bot_count: usize,
    pub bot_skill: f32,
    /// Spawn every player with a weapon. **Development only, default off.**
    ///
    /// The game's design is that you find your weapons (`docs/32`), and that is
    /// not negotiable — but a checkpoint that has to demonstrate terrain
    /// destruction cannot begin by walking a bot to a crate. The sandbox already
    /// grants a loadout for the same reason.
    pub dev_loadout: bool,

    /// Spawn every player on this much health. **Development only, 0 = off.**
    ///
    /// Sibling of `dev_loadout`, and for the same reason. The death-overlay check
    /// has to produce a real death through the real damage path, and a rocket at
    /// your own feet gets weaker every shot: each blast deepens the crater, so
    /// the next detonates further below you (~10 damage against ~25 for the
    /// first, measured). At `BASE_HEALTH` and eight rockets that is a coin flip,
    /// and a gate that fails on a coin flip gates nothing (§A28).
    ///
    /// This changes the **starting** health only. The kill is still a real
    /// rocket, resolved by the server, with real attribution — the same thing
    /// `world_step`'s unit test does when it sets 20 health and fires once.
    pub dev_start_health: f32,
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
            map_generator: DEFAULT_MAP_GENERATOR,
            max_players: MAX_PLAYERS,
            round_seconds: ROUND_SECONDS,
            room_empty_ttl: ROOM_EMPTY_TTL,
            lobby_bot_timeout: LOBBY_BOT_TIMEOUT,
            fixed_seed: None,
            record_replay: false,
            replay_dir: "replays".to_string(),
            debug_dump: false,
            bot_count: BOT_COUNT_DEFAULT,
            dev_loadout: false,
            dev_start_health: 0.0,
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

        let map_generator = match get("MAP_GENERATOR") {
            Some(v) => MapGenerator::parse(&v).ok_or_else(|| ConfigError {
                var: "MAP_GENERATOR",
                value: v.clone(),
                expected: "one of: v1, v2".to_string(),
            })?,
            None => d.map_generator,
        };

        let max_players = parse_usize(&get, "MAX_PLAYERS", d.max_players, 1, MAX_PLAYERS)?;

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

        let room_empty_ttl = match get("ROOM_EMPTY_TTL") {
            Some(v) => {
                let n = v.parse::<f32>().map_err(|_| ConfigError {
                    var: "ROOM_EMPTY_TTL",
                    value: v.clone(),
                    expected: "a positive number of seconds".to_string(),
                })?;
                if !(n.is_finite() && n > 0.0) {
                    return Err(ConfigError {
                        var: "ROOM_EMPTY_TTL",
                        value: v,
                        expected: "a positive number of seconds".to_string(),
                    });
                }
                n
            }
            None => d.room_empty_ttl,
        };

        let lobby_bot_timeout = match get("LOBBY_BOT_TIMEOUT") {
            Some(v) => {
                let n = v.parse::<f32>().map_err(|_| ConfigError {
                    var: "LOBBY_BOT_TIMEOUT",
                    value: v.clone(),
                    expected: "a positive number of seconds".to_string(),
                })?;
                if !(n.is_finite() && n > 0.0) {
                    return Err(ConfigError {
                        var: "LOBBY_BOT_TIMEOUT",
                        value: v,
                        expected: "a positive number of seconds".to_string(),
                    });
                }
                n
            }
            None => d.lobby_bot_timeout,
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
        let replay_dir = get("REPLAY_DIR").unwrap_or(d.replay_dir);
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
            map_generator,
            max_players,
            round_seconds,
            room_empty_ttl,
            lobby_bot_timeout,
            fixed_seed,
            record_replay,
            replay_dir,
            debug_dump,
            bot_count,
            bot_skill,
            dev_loadout: matches!(get("DEV_LOADOUT").as_deref(), Some("1") | Some("true")),
            dev_start_health: get("DEV_START_HEALTH")
                .and_then(|v| v.parse::<f32>().ok())
                .filter(|v| *v > 0.0)
                .unwrap_or(0.0),
        })
    }

    /// One line, `key=value`, for the startup log (`docs/61-logging-debug.md` §2).
    pub fn summary(&self) -> String {
        format!(
            "bind={} scale={} generator={} max_players={} round_seconds={} \
             room_empty_ttl={} lobby_bot_timeout={} fixed_seed={} record_replay={} debug_dump={} bots={} \
             bot_skill={} dev_start_health={}",
            self.bind_addr,
            self.map_scale.as_str(),
            self.map_generator.as_str(),
            self.max_players,
            self.round_seconds,
            self.room_empty_ttl,
            self.lobby_bot_timeout,
            self.fixed_seed
                .map(|s| s.to_string())
                .unwrap_or_else(|| "random".to_string()),
            self.record_replay,
            self.debug_dump,
            self.bot_count,
            self.bot_skill,
            self.dev_start_health,
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
        // Pinned to the constants, not to a literal (§A19, §B22): these read
        // "the documented defaults", and a literal here documents whatever it
        // was written against — it went stale the moment T11.16 moved the
        // scale, and reported a deliberate change as a failure.
        assert_eq!(c.map_scale, DEFAULT_MAP_SCALE);
        assert_eq!(c.max_players, MAX_PLAYERS);
        assert_eq!(c.round_seconds, 240.0);
        assert_eq!(c.fixed_seed, None);
        assert!(!c.record_replay);
        assert!(!c.debug_dump);
        assert_eq!(c.bot_count, BOT_COUNT_DEFAULT);
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
        assert!(s.contains(&format!("scale={}", DEFAULT_MAP_SCALE.as_str())));
        assert!(s.contains("fixed_seed=random"));
    }
}
