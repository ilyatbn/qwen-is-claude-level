//! Binary wire formats: `map_init`, `snapshot`, and the inbound `input` batch.
//!
//! All little-endian, all layouts exactly as `docs/40-net-protocol.md` §2–§3.
//!
//! The decoders here read **attacker-controlled bytes**. A panic in one is a
//! remote crash, so every one of them returns `Result` and none of them indexes
//! without checking. The fuzz tests are not decoration.

use game_core::constants::{
    BATTERY_MAX, CHUNK_SIZE, HEALTH_CAP, INPUT_REDUNDANCY, JETPACK_MAX_FUEL, SNAPSHOT_FOOTER_BYTES,
    SNAPSHOT_HEADER_BYTES, SNAPSHOT_PLAYER_BYTES,
};
use game_core::map::{rle, Map};
use game_core::player::input::Input;
use game_core::player::state::PlayerId;
use game_core::world::World;

/// `"MAP1"`, so a version skew fails loudly instead of decoding garbage.
pub const MAP_MAGIC: u32 = 0x4D41_5031;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodecError {
    Truncated { need: usize, had: usize },
    BadCount(u8),
    TrailingBytes(usize),
    BadMapInit(&'static str),
}

impl std::fmt::Display for CodecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CodecError::Truncated { need, had } => {
                write!(f, "truncated: need {need} bytes, had {had}")
            }
            CodecError::BadCount(n) => write!(f, "bad input count {n}"),
            CodecError::TrailingBytes(n) => write!(f, "{n} trailing bytes"),
            CodecError::BadMapInit(what) => write!(f, "bad map_init: {what}"),
        }
    }
}

impl std::error::Error for CodecError {}

// ---------------------------------------------------------------------------
// map_init — once per round
// ---------------------------------------------------------------------------

/// ```text
/// u32 magic  u32 width  u32 height  u64 seed  u8 scale  u8 theme  f32 wind
/// u16 spawn_count      then spawn_count × (i16 x, i16 y)
/// u16 decoration_count then decoration_count × (u16 kind, i16 x, i16 y, u8 flags)
/// u32 rle_byte_len     then the RLE payload
/// ```
///
/// **Buried item slots are deliberately absent.** Sending them would put a
/// complete treasure map in every client's memory, which is a straightforward
/// wallhack for the game's most interesting mechanic (`docs/32` §5). The omission
/// looks like an oversight to anyone extending this struct later, so: it is not.
///
/// `surface_points` are also not sent — large, and the client can derive
/// standability from the mask if it ever needs to.
pub fn encode_map_init(map: &Map) -> Vec<u8> {
    encode_map_init_at(map, 0)
}

/// `carve_seq` is the last carve the mask already contains. A client sets its
/// expectation from it, which is what lets a mid-round joiner — or any resync —
/// pick the carve stream up in the right place.
pub fn encode_map_init_at(map: &Map, carve_seq: u32) -> Vec<u8> {
    let payload = rle::encode(&map.mask);
    let m = &map.meta;
    let mut b = Vec::with_capacity(payload.len() + 64 + m.spawn_points.len() * 4);

    b.extend_from_slice(&MAP_MAGIC.to_le_bytes());
    b.extend_from_slice(&map.mask.w.to_le_bytes());
    b.extend_from_slice(&map.mask.h.to_le_bytes());
    b.extend_from_slice(&m.seed.to_le_bytes());
    b.push(scale_byte(m.scale));
    b.push(m.theme);
    b.extend_from_slice(&m.wind.to_le_bytes());
    b.extend_from_slice(&carve_seq.to_le_bytes());

    b.extend_from_slice(&(m.spawn_points.len() as u16).to_le_bytes());
    for p in &m.spawn_points {
        b.extend_from_slice(&(p.x as i16).to_le_bytes());
        b.extend_from_slice(&(p.y as i16).to_le_bytes());
    }

    b.extend_from_slice(&(m.decorations.len() as u16).to_le_bytes());
    for d in &m.decorations {
        b.extend_from_slice(&d.kind.to_le_bytes());
        b.extend_from_slice(&(d.pos.x as i16).to_le_bytes());
        b.extend_from_slice(&(d.pos.y as i16).to_le_bytes());
        b.push(u8::from(d.flip) | (d.scale_tier << 1));
    }

    b.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    b.extend_from_slice(&payload);
    b
}

/// The inverse of `encode_map_init`, as far as the mask.
///
/// Only the mask is recovered: it is what a replay, a divergence check or a
/// headless tool actually needs, and reconstructing a full `MapMeta` from the
/// wire would be inventing the fields the format deliberately omits (buried
/// slots never cross the wire — `docs/32` §5).
///
/// This exists because `encode_map_init` had no inverse, so nothing could prove
/// it round-trips, and the mask-agreement test would otherwise have had to parse
/// the format a second time — two parsers that will eventually disagree.
pub fn decode_map_init_mask(bytes: &[u8]) -> Result<game_core::map::Mask, CodecError> {
    let mut r = Reader::new(bytes);
    if r.u32()? != MAP_MAGIC {
        return Err(CodecError::BadMapInit("magic"));
    }
    let w = r.u32()?;
    let h = r.u32()?;
    if !dimensions_are_sane(w, h) {
        return Err(CodecError::BadMapInit("dimensions"));
    }
    r.take(8)?; // seed
    r.u8()?; // scale
    r.u8()?; // theme
    r.take(4)?; // wind
    r.u32()?; // carve_seq

    let spawns = r.u16()? as usize;
    r.take(spawns * 4)?;
    let decos = r.u16()? as usize;
    r.take(decos * 7)?;

    let payload_len = r.u32()? as usize;
    let payload = r.take(payload_len)?;
    let mask =
        game_core::map::rle::decode(w, h, payload).map_err(|_| CodecError::BadMapInit("rle"))?;
    r.finish()?;
    Ok(mask)
}

fn scale_byte(s: game_core::constants::MapScale) -> u8 {
    use game_core::constants::MapScale::*;
    match s {
        Small => 0,
        Medium => 1,
        Large => 2,
    }
}

// ---------------------------------------------------------------------------
// snapshot — 20 Hz
// ---------------------------------------------------------------------------

/// `SNAPSHOT_HEADER_BYTES + n*SNAPSHOT_PLAYER_BYTES + SNAPSHOT_FOOTER_BYTES`
/// — 8 + 15n + 4, so 102 bytes for six players.
///
/// **`docs/40-net-protocol.md` §3's totals do not match its own field lists**, in
/// two places; see `SNAPSHOT_PLAYER_BYTES` for the arithmetic. This follows the
/// field lists, because they are complete and typed while the totals are a slip,
/// and because hitting the stated 14 would mean dropping a field the client needs.
///
/// `last_input_seq` is **per recipient** — the highest sequence the server had
/// processed *from that client* — which is why this takes `for_player`. Everything
/// else is identical for everyone.
pub fn encode_snapshot(world: &World, _for_player: PlayerId, last_input_seq: u32) -> Vec<u8> {
    let players: Vec<_> = world.players.iter().collect();
    let mut b = Vec::with_capacity(
        SNAPSHOT_HEADER_BYTES + players.len() * SNAPSHOT_PLAYER_BYTES + SNAPSHOT_FOOTER_BYTES,
    );

    b.extend_from_slice(&world.tick.to_le_bytes());
    let ds = (world.round_time * 10.0).clamp(0.0, u16::MAX as f32) as u16;
    b.extend_from_slice(&ds.to_le_bytes());
    b.push((world.darkness() * 255.0).clamp(0.0, 255.0) as u8);
    b.push(players.len().min(255) as u8);

    for p in players.iter().take(255) {
        b.push(p.id);
        // Clamp rather than wrap. A wrapped velocity teleports a player across the
        // map, and a wrapped position puts them inside the opposite wall.
        b.extend_from_slice(&clamp_i16(p.body.pos.x).to_le_bytes());
        b.extend_from_slice(&clamp_i16(p.body.pos.y).to_le_bytes());
        b.extend_from_slice(&clamp_i16(p.body.vel.x).to_le_bytes());
        b.extend_from_slice(&clamp_i16(p.body.vel.y).to_le_bytes());
        b.extend_from_slice(&p.aim.to_le_bytes());
        b.push(p.health.clamp(0.0, HEALTH_CAP) as u8);

        let now = world.round_time;
        let mut flags = 0u8;
        flags |= u8::from(p.alive);
        flags |= u8::from(p.body.grounded) << 1;
        flags |= u8::from(p.jetpack.active) << 2;
        flags |= u8::from(p.shield_active(now)) << 3;
        flags |= u8::from(p.flashlight_on) << 4;
        flags |= u8::from(p.invulnerable(now)) << 5;
        b.push(flags);

        b.push((p.jetpack.fuel / JETPACK_MAX_FUEL * 255.0).clamp(0.0, 255.0) as u8);
        // 255 means "none". There are 6 items, so this is safe; it breaks past 254.
        b.push(match p.inventory.selected_stack() {
            Some(s) => (s.item & 0xFF) as u8,
            None => 255,
        });
        // Vision: this player's own FoV multiplier, fog times smoke (T11.08).
        //
        // Authoritative because smoke is **positional** — what you can see depends
        // on which cloud you are standing in, so the client cannot derive it from a
        // global effect flag. Before this byte existed `GameScene` hardcoded
        // `fogMult: 1` and `World::fog_multiplier` had no caller at all: heavy fog
        // was simulated every round and changed nothing anyone could see.
        b.push((world.vision_multiplier(p) * 255.0).clamp(0.0, 255.0) as u8);
        // Battery: the energy pool §C8's blue bar shows and §B5's shield spends.
        // Quantised like fuel — a bar has nowhere near 256 pixels of height, and
        // the readout beside it is rounded to a whole percent.
        b.push((p.battery / BATTERY_MAX * 255.0).clamp(0.0, 255.0) as u8);
    }

    b.extend_from_slice(&last_input_seq.to_le_bytes());
    b
}

fn clamp_i16(v: f32) -> i16 {
    v.clamp(i16::MIN as f32, i16::MAX as f32) as i16
}

/// Decoded snapshot, for the Rust-side round-trip tests. The real consumer is the
/// TypeScript decoder.
#[derive(Debug, Clone, PartialEq)]
pub struct SnapshotView {
    pub tick: u32,
    pub round_time: f32,
    pub darkness: u8,
    pub players: Vec<SnapshotPlayer>,
    pub last_input_seq: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SnapshotPlayer {
    pub id: PlayerId,
    pub x: i16,
    pub y: i16,
    pub vx: i16,
    pub vy: i16,
    pub aim: u16,
    pub health: u8,
    pub flags: u8,
    pub jetpack_fuel: u8,
    pub selected_item: u8,
    /// FoV multiplier, fog times smoke, quantised (T11.08).
    pub vision: u8,
    /// Energy pool, quantised against `BATTERY_MAX` (T14.02).
    pub battery: u8,
}

pub fn decode_snapshot(b: &[u8]) -> Result<SnapshotView, CodecError> {
    let mut r = Reader::new(b);
    let tick = r.u32()?;
    let round_time = r.u16()? as f32 / 10.0;
    let darkness = r.u8()?;
    let n = r.u8()? as usize;

    let mut players = Vec::with_capacity(n.min(64));
    for _ in 0..n {
        players.push(SnapshotPlayer {
            id: r.u8()?,
            x: r.i16()?,
            y: r.i16()?,
            vx: r.i16()?,
            vy: r.i16()?,
            aim: r.u16()?,
            health: r.u8()?,
            flags: r.u8()?,
            jetpack_fuel: r.u8()?,
            selected_item: r.u8()?,
            vision: r.u8()?,
            battery: r.u8()?,
        });
    }
    let last_input_seq = r.u32()?;
    r.finish()?;
    Ok(SnapshotView {
        tick,
        round_time,
        darkness,
        players,
        last_input_seq,
    })
}

// ---------------------------------------------------------------------------
// input — inbound, ~60 Hz, untrusted
// ---------------------------------------------------------------------------

/// ```text
/// u8 count (1..=INPUT_REDUNDANCY)
/// per input (7 bytes): u32 seq, u16 aim, u8 buttons
/// ```
///
/// Redundancy is what makes this robust: each packet carries the last 3 inputs, so
/// a dropped packet costs nothing. That works only because the wire format is
/// **held state, not edges** — a lost edge is gone forever, a lost "button is down"
/// is re-established by the next packet.
pub fn decode_input_batch(b: &[u8]) -> Result<Vec<Input>, CodecError> {
    let mut r = Reader::new(b);
    let count = r.u8()?;
    if count == 0 || count as usize > INPUT_REDUNDANCY {
        return Err(CodecError::BadCount(count));
    }
    let mut out = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let seq = r.u32()?;
        let aim = r.u16()?;
        // Bit 7 is reserved: mask it off rather than rejecting, so a future client
        // that sets it degrades gracefully instead of being disconnected.
        let buttons = r.u8()? & 0x7F;
        out.push(Input::new(seq, buttons, aim));
    }
    r.finish()?;
    Ok(out)
}

pub fn encode_input_batch(inputs: &[Input]) -> Vec<u8> {
    let take = inputs.len().min(INPUT_REDUNDANCY);
    let start = inputs.len() - take;
    let mut b = Vec::with_capacity(1 + take * 7);
    b.push(take as u8);
    for i in &inputs[start..] {
        b.extend_from_slice(&i.seq.to_le_bytes());
        b.extend_from_slice(&i.aim.to_le_bytes());
        b.push(i.buttons);
    }
    b
}

// ---------------------------------------------------------------------------
// A bounds-checked reader. Every `?` here is a rejected packet, not a panic.
// ---------------------------------------------------------------------------

struct Reader<'a> {
    b: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn new(b: &'a [u8]) -> Self {
        Reader { b, at: 0 }
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8], CodecError> {
        let end = self.at.checked_add(n).ok_or(CodecError::Truncated {
            need: n,
            had: self.b.len(),
        })?;
        if end > self.b.len() {
            return Err(CodecError::Truncated {
                need: end,
                had: self.b.len(),
            });
        }
        let s = &self.b[self.at..end];
        self.at = end;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8, CodecError> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, CodecError> {
        let s = self.take(2)?;
        Ok(u16::from_le_bytes([s[0], s[1]]))
    }
    fn i16(&mut self) -> Result<i16, CodecError> {
        Ok(self.u16()? as i16)
    }
    fn u32(&mut self) -> Result<u32, CodecError> {
        let s = self.take(4)?;
        Ok(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }
    /// A buffer longer than the layout implies is rejected: it means the sender and
    /// this decoder disagree about the format, and guessing is worse than saying so.
    fn finish(self) -> Result<(), CodecError> {
        if self.at != self.b.len() {
            return Err(CodecError::TrailingBytes(self.b.len() - self.at));
        }
        Ok(())
    }
}

/// `width`/`height` must be multiples of `CHUNK_SIZE`. Exposed so the client's
/// validation and the server's agree by construction.
pub fn dimensions_are_sane(w: u32, h: u32) -> bool {
    w > 0
        && h > 0
        && w.is_multiple_of(CHUNK_SIZE)
        && h.is_multiple_of(CHUNK_SIZE)
        && w <= 8192
        && h <= 8192
}

// ---------------------------------------------------------------------------
// Base64, because raw binary attachments are not reliable on this stack
// ---------------------------------------------------------------------------

/// Standard base64, no line breaks.
///
/// **Why the binary payloads are wrapped in text.** `map_init` and `snapshot` are
/// specified as socket.io binary attachments (`docs/40-net-protocol.md` §3), and
/// that does not survive: a payload containing `0x1e` — engine.io's packet
/// separator — corrupts the stream. Measured on a real Small map: 13,491 bytes
/// carrying **48** separator bytes, after which the client received nothing at all
/// on that socket, not even later plain-text events. It reads as a dead connection
/// rather than a dropped message, which is what made it expensive to find.
///
/// It is not the polling transport alone: forcing websocket-only fails the same
/// way. Arbitrary bytes are simply not safe as attachments here.
///
/// Base64 costs a third more: `map_init` goes from ~13 KB to ~18 KB once per round,
/// and a six-player snapshot from 102 to 136 bytes, so 2.7 KB/s at 20 Hz against
/// the 1.9 KB/s the doc budgeted. Both are far inside `docs/40` §4, and a correct
/// 136 bytes beats a corrupt 102.
pub fn b64_encode(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 {
            T[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if c.len() > 2 {
            T[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// The inverse, for tests and for the replay tooling.
pub fn b64_decode(s: &str) -> Option<Vec<u8>> {
    let val = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => (c - b'A') as u32,
            b'a'..=b'z' => (c - b'a') as u32 + 26,
            b'0'..=b'9' => (c - b'0') as u32 + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        })
    };
    let raw: Vec<u8> = s.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    if !raw.len().is_multiple_of(4) {
        return None;
    }
    let mut out = Vec::with_capacity(raw.len() / 4 * 3);
    for c in raw.chunks(4) {
        let pad = c.iter().filter(|b| **b == b'=').count();
        if pad > 2 {
            return None;
        }
        let mut n = 0u32;
        for (i, b) in c.iter().enumerate() {
            n |= if *b == b'=' { 0 } else { val(*b)? } << (18 - 6 * i);
        }
        out.push((n >> 16) as u8);
        if pad < 2 {
            out.push((n >> 8) as u8);
        }
        if pad < 1 {
            out.push(n as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use game_core::constants::{MapScale, SIM_DT};
    use game_core::player::input::button;
    use game_core::world::{RoundPhase, World};

    fn world_with(n: u8) -> World {
        let mut w = World::new(4242, MapScale::Small);
        for id in 0..n {
            w.add_player(id, 0, format!("p{id}"));
        }
        w.set_phase(RoundPhase::Playing);
        let _ = w.drain_events();
        w
    }

    // ------------------------------------------------------------- map_init

    #[test]
    fn map_init_starts_with_the_magic_number() {
        let map = game_core::map::generate(7, MapScale::Small);
        let b = encode_map_init(&map);
        assert_eq!(u32::from_le_bytes([b[0], b[1], b[2], b[3]]), MAP_MAGIC);
    }

    #[test]
    fn map_init_length_matches_the_layout() {
        let map = game_core::map::generate(7, MapScale::Small);
        let b = encode_map_init(&map);
        let rle_len = rle::encode(&map.mask).len();
        let expect = 4
            + 4
            + 4
            + 8
            + 1
            + 1
            + 4
            + 4 // carve_seq
            + 2
            + map.meta.spawn_points.len() * 4
            + 2
            + map.meta.decorations.len() * 7
            + 4
            + rle_len;
        assert_eq!(b.len(), expect);
    }

    #[test]
    fn map_init_carries_the_dimensions_seed_and_counts() {
        let map = game_core::map::generate(7, MapScale::Small);
        let b = encode_map_init(&map);
        assert_eq!(u32::from_le_bytes([b[4], b[5], b[6], b[7]]), map.mask.w);
        assert_eq!(u32::from_le_bytes([b[8], b[9], b[10], b[11]]), map.mask.h);
        let seed = u64::from_le_bytes(b[12..20].try_into().expect("8 bytes"));
        assert_eq!(seed, map.meta.seed);
        // 4 magic + 4 w + 4 h + 8 seed + 1 scale + 1 theme + 4 wind + 4 carve_seq
        let sc = u16::from_le_bytes([b[30], b[31]]) as usize;
        assert_eq!(sc, map.meta.spawn_points.len());
    }

    /// The anti-wallhack test. Buried slots must not be recoverable from the
    /// payload, or digging stops being speculative.
    #[test]
    fn no_buried_slot_coordinates_appear_anywhere_in_map_init() {
        let map = game_core::map::generate(4242, MapScale::Small);
        assert!(
            !map.meta.buried_slots.is_empty(),
            "the map must have buried slots or this proves nothing"
        );
        let b = encode_map_init(&map);

        for slot in &map.meta.buried_slots {
            let pat: [u8; 4] = {
                let x = (slot.pos.x as i16).to_le_bytes();
                let y = (slot.pos.y as i16).to_le_bytes();
                [x[0], x[1], y[0], y[1]]
            };
            assert!(
                !b.windows(4).any(|w| w == pat),
                "buried slot {:?} is recoverable from map_init",
                slot.pos
            );
        }
    }

    // ------------------------------------------------------------- snapshot

    /// Pinned against the constants rather than literals, so the wire format and
    /// the documented size cannot drift apart silently.
    #[test]
    fn snapshot_length_is_exactly_header_plus_n_players_plus_footer() {
        for n in [0u8, 1, 6] {
            let w = world_with(n);
            let b = encode_snapshot(&w, 0, 0);
            assert_eq!(
                b.len(),
                SNAPSHOT_HEADER_BYTES + n as usize * SNAPSHOT_PLAYER_BYTES + SNAPSHOT_FOOTER_BYTES,
                "n = {n}"
            );
        }
        // Derived, not a literal (§A19). This said `102`, and T11.08's sixteenth
        // byte expired it — a number spelled out here has to be edited by hand
        // every time the wire grows, and the edit is indistinguishable from
        // rubber-stamping whatever the encoder now happens to produce.
        let w = world_with(6);
        assert_eq!(
            encode_snapshot(&w, 0, 0).len(),
            SNAPSHOT_HEADER_BYTES + 6 * SNAPSHOT_PLAYER_BYTES + SNAPSHOT_FOOTER_BYTES
        );
    }

    #[test]
    fn every_snapshot_field_round_trips() {
        let mut w = world_with(3);
        for _ in 0..10 {
            w.step(SIM_DT);
        }
        if let Some(p) = w.player_mut(1) {
            p.health = 137.0;
            p.aim = 40_000;
            p.flashlight_on = true;
        }
        let b = encode_snapshot(&w, 0, 99);
        let s = decode_snapshot(&b).expect("round trip");

        assert_eq!(s.tick, w.tick);
        assert_eq!(s.players.len(), 3);
        assert_eq!(s.last_input_seq, 99);
        assert!((s.round_time - w.round_time).abs() < 0.1);

        let p1 = s.players.iter().find(|p| p.id == 1).expect("player 1");
        assert_eq!(p1.health, 137);
        assert_eq!(p1.aim, 40_000);
        assert_ne!(p1.flags & (1 << 4), 0, "flashlight flag");
    }

    #[test]
    fn health_of_one_fifty_encodes_as_one_fifty() {
        let mut w = world_with(1);
        if let Some(p) = w.player_mut(0) {
            p.health = HEALTH_CAP;
        }
        let s = decode_snapshot(&encode_snapshot(&w, 0, 0)).expect("decode");
        assert_eq!(s.players[0].health, 150);
    }

    /// A wrapped velocity teleports a player across the map; a clamped one just
    /// looks fast for a frame.
    #[test]
    fn an_out_of_range_velocity_is_clamped_not_wrapped() {
        let mut w = world_with(1);
        if let Some(p) = w.player_mut(0) {
            p.body.vel.x = 90_000.0;
            p.body.vel.y = -90_000.0;
        }
        let s = decode_snapshot(&encode_snapshot(&w, 0, 0)).expect("decode");
        assert_eq!(s.players[0].vx, i16::MAX, "sign must survive");
        assert_eq!(s.players[0].vy, i16::MIN);
    }

    #[test]
    fn each_flag_bit_maps_to_its_own_field() {
        let mut w = world_with(1);
        let now = w.round_time;
        // Start from a known-clear state.
        if let Some(p) = w.player_mut(0) {
            p.alive = false;
            p.body.grounded = false;
            p.jetpack.active = false;
            p.shield_until = None;
            p.flashlight_on = false;
            p.iframes_until = 0.0;
        }
        let s = decode_snapshot(&encode_snapshot(&w, 0, 0)).expect("decode");
        assert_eq!(s.players[0].flags, 0, "all clear");

        type SetFlag = fn(&mut game_core::player::state::PlayerState, f32);
        let cases: [(u8, SetFlag); 6] = [
            (0, |p, _| p.alive = true),
            (1, |p, _| p.body.grounded = true),
            (2, |p, _| p.jetpack.active = true),
            (3, |p, n| p.shield_until = Some(n + 10.0)),
            (4, |p, _| p.flashlight_on = true),
            (5, |p, n| p.iframes_until = n + 10.0),
        ];
        for (bit, set) in cases {
            let mut w = world_with(1);
            if let Some(p) = w.player_mut(0) {
                p.alive = false;
                p.body.grounded = false;
                p.jetpack.active = false;
                p.shield_until = None;
                p.flashlight_on = false;
                p.iframes_until = 0.0;
                set(p, now);
            }
            let s = decode_snapshot(&encode_snapshot(&w, 0, 0)).expect("decode");
            assert_eq!(
                s.players[0].flags,
                1 << bit,
                "bit {bit} should be the only one set"
            );
        }
    }

    #[test]
    fn last_input_seq_differs_per_recipient_for_one_world() {
        let w = world_with(2);
        let a = decode_snapshot(&encode_snapshot(&w, 0, 11)).expect("a");
        let b = decode_snapshot(&encode_snapshot(&w, 1, 22)).expect("b");
        assert_eq!(a.last_input_seq, 11);
        assert_eq!(b.last_input_seq, 22);
        // Everything else is identical, which is what makes the future
        // encode-once-patch-the-tail optimisation possible.
        assert_eq!(a.players, b.players);
    }

    #[test]
    fn a_truncated_snapshot_is_rejected() {
        let w = world_with(3);
        let full = encode_snapshot(&w, 0, 0);
        for cut in 0..full.len() {
            assert!(
                decode_snapshot(&full[..cut]).is_err(),
                "prefix of {cut} bytes decoded"
            );
        }
    }

    #[test]
    fn a_player_count_disagreeing_with_the_length_is_rejected() {
        let w = world_with(3);
        let mut b = encode_snapshot(&w, 0, 0);
        b[7] = 200; // the count byte: claim 200 players
        assert!(decode_snapshot(&b).is_err());
    }

    // ---------------------------------------------------------------- input

    #[test]
    fn input_batches_are_the_documented_size() {
        for (n, size) in [(1usize, 8usize), (2, 15), (3, 22)] {
            let inputs: Vec<Input> = (1..=n as u32).map(|s| Input::new(s, 0, 0)).collect();
            assert_eq!(encode_input_batch(&inputs).len(), size, "{n} inputs");
        }
    }

    #[test]
    fn more_than_redundancy_inputs_sends_only_the_last_three() {
        let inputs: Vec<Input> = (1..=10u32).map(|s| Input::new(s, 0, 0)).collect();
        let b = encode_input_batch(&inputs);
        let got = decode_input_batch(&b).expect("decode");
        assert_eq!(
            got.iter().map(|i| i.seq).collect::<Vec<_>>(),
            vec![8, 9, 10]
        );
    }

    #[test]
    fn an_input_batch_round_trips() {
        let inputs = vec![
            Input::new(7, button::LEFT | button::JUMP, 1234),
            Input::new(8, button::RIGHT, 65_535),
            Input::new(9, button::FIRE | button::FLASHLIGHT, 0),
        ];
        let got = decode_input_batch(&encode_input_batch(&inputs)).expect("decode");
        assert_eq!(got.len(), 3);
        for (a, b) in inputs.iter().zip(got.iter()) {
            assert_eq!((a.seq, a.aim, a.buttons), (b.seq, b.aim, b.buttons));
        }
    }

    #[test]
    fn a_zero_or_oversized_count_is_rejected() {
        assert!(decode_input_batch(&[0]).is_err());
        let mut b = vec![(INPUT_REDUNDANCY + 1) as u8];
        b.resize(1 + (INPUT_REDUNDANCY + 1) * 7, 0);
        assert!(decode_input_batch(&b).is_err());
    }

    #[test]
    fn truncated_and_overlong_input_batches_are_rejected() {
        let full = encode_input_batch(&[Input::new(1, 0, 0), Input::new(2, 0, 0)]);
        for cut in 0..full.len() {
            assert!(decode_input_batch(&full[..cut]).is_err(), "prefix {cut}");
        }
        let mut over = full.clone();
        over.push(0);
        assert!(decode_input_batch(&over).is_err(), "trailing byte accepted");
    }

    /// Reserved bit 7 degrades gracefully rather than disconnecting a future
    /// client that sets it.
    #[test]
    fn reserved_bit_seven_is_masked_off_not_rejected() {
        let b = vec![1u8, 5, 0, 0, 0, 0, 0, 0xFF];
        let got = decode_input_batch(&b).expect("must not be rejected");
        assert_eq!(got[0].buttons, 0x7F);
    }

    /// A panic in a decoder reachable from the network is a remote crash.
    #[test]
    fn the_decoders_never_panic_on_arbitrary_bytes() {
        let mut state = 0x1234_5678_9ABC_DEF0u64;
        let mut next = || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        for _ in 0..10_000 {
            let len = (next() % 64) as usize;
            let buf: Vec<u8> = (0..len).map(|_| (next() & 0xFF) as u8).collect();
            let _ = decode_input_batch(&buf);
            let _ = decode_snapshot(&buf);
        }

        // And corruptions of valid frames, which explore the parser far deeper
        // than random noise does.
        let w = world_with(4);
        let snap = encode_snapshot(&w, 0, 5);
        let inp = encode_input_batch(&[Input::new(1, 3, 9), Input::new(2, 0, 1)]);
        for base in [snap, inp] {
            for i in 0..base.len() {
                for bit in 0..8 {
                    let mut c = base.clone();
                    c[i] ^= 1 << bit;
                    let _ = decode_snapshot(&c);
                    let _ = decode_input_batch(&c);
                }
                let _ = decode_snapshot(&base[..i]);
                let _ = decode_input_batch(&base[..i]);
            }
        }
    }

    #[test]
    fn base64_round_trips_including_every_byte_value_and_both_paddings() {
        for len in 0..8usize {
            let v: Vec<u8> = (0..len).map(|i| (i * 37 + 11) as u8).collect();
            assert_eq!(
                b64_decode(&b64_encode(&v)).as_deref(),
                Some(&v[..]),
                "len {len}"
            );
        }
        let all: Vec<u8> = (0..=255u8).collect();
        assert_eq!(b64_decode(&b64_encode(&all)).as_deref(), Some(&all[..]));
        // The byte that started all this.
        let seps = vec![0x1eu8; 100];
        assert_eq!(b64_decode(&b64_encode(&seps)).as_deref(), Some(&seps[..]));
        assert!(b64_decode("abc").is_none(), "bad length rejected");
        assert!(b64_decode("ab*d").is_none(), "bad alphabet rejected");
    }

    /// The encoded form must not contain engine.io's packet separator, which is
    /// the entire point of encoding it.
    #[test]
    fn encoded_payloads_are_free_of_the_separator_byte() {
        let map = game_core::map::generate(4242, MapScale::Small);
        let raw = encode_map_init(&map);
        assert!(
            raw.contains(&0x1e),
            "this map has no separator bytes, so it proves nothing"
        );
        assert!(!b64_encode(&raw).as_bytes().contains(&0x1e));
    }

    #[test]
    fn dimensions_must_be_chunk_multiples() {
        assert!(dimensions_are_sane(2048, 1024));
        assert!(!dimensions_are_sane(2000, 1024));
        assert!(!dimensions_are_sane(0, 1024));
        assert!(!dimensions_are_sane(100_000, 1024));
    }
}
