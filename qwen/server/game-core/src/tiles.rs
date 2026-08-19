//! `tiles` — the tile grid: kinds, HP, destruction (docs/01 §2, §5).

use serde::{Deserialize, Serialize};

/// Tile size in pixels (docs/01 §1).
pub const TILE_SIZE: f32 = 16.0;

/// docs/01 §2.
///
/// A tile is SOLID iff `kind != AIR`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
pub enum TileKind {
    #[default]
    Air,
    Grass,
    Dirt,
    Stone,
    Rock,
}

impl TileKind {
    /// Starting HP for this kind (docs/01 §2 table).
    pub const fn base_hp(self) -> f32 {
        match self {
            TileKind::Air => 0.0,
            TileKind::Grass => 20.0,
            TileKind::Dirt => 30.0,
            TileKind::Stone => 60.0,
            TileKind::Rock => 80.0,
        }
    }

    /// docs/01 §2: "A tile is SOLID iff kind != AIR".
    pub const fn is_solid(self) -> bool {
        !matches!(self, TileKind::Air)
    }

    /// Wire encoding (docs/06 §6): 0=AIR 1=GRASS 2=DIRT 3=STONE 4=ROCK.
    pub const fn to_byte(self) -> u8 {
        match self {
            TileKind::Air => 0,
            TileKind::Grass => 1,
            TileKind::Dirt => 2,
            TileKind::Stone => 3,
            TileKind::Rock => 4,
        }
    }

    /// Inverse of [`TileKind::to_byte`]. Unknown bytes decode to `Air`.
    pub const fn from_byte(byte: u8) -> TileKind {
        match byte {
            1 => TileKind::Grass,
            2 => TileKind::Dirt,
            3 => TileKind::Stone,
            4 => TileKind::Rock,
            _ => TileKind::Air,
        }
    }
}

/// docs/01 §2: "Tile struct: `{ kind, hp }`".
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Tile {
    pub kind: TileKind,
    pub hp: f32,
}

impl Tile {
    /// A tile of `kind` at full HP.
    pub const fn new(kind: TileKind) -> Self {
        Tile {
            kind,
            hp: kind.base_hp(),
        }
    }

    /// The empty tile.
    pub const AIR: Tile = Tile {
        kind: TileKind::Air,
        hp: 0.0,
    };

    pub const fn is_solid(self) -> bool {
        self.kind.is_solid()
    }
}

/// Decor kind (docs/01 §3 step 4) — visual only, non-solid.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DecorKind {
    Bush,
    Rock,
    Flower,
}

impl DecorKind {
    /// Wire name (docs/06 §6 `decor[].kind`).
    pub const fn as_str(self) -> &'static str {
        match self {
            DecorKind::Bush => "bush",
            DecorKind::Rock => "rock",
            DecorKind::Flower => "flower",
        }
    }
}

/// A decor placement (docs/01 §3 step 4): `Vec<(x, y, kind)>`, y = surface row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Decor {
    pub x: u32,
    pub y: u32,
    pub kind: DecorKind,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tile_hp_matches_doc_table() {
        // docs/01 §2 table — this test IS the doc check.
        assert_eq!(TileKind::Air.base_hp(), 0.0);
        assert_eq!(TileKind::Grass.base_hp(), 20.0);
        assert_eq!(TileKind::Dirt.base_hp(), 30.0);
        assert_eq!(TileKind::Stone.base_hp(), 60.0);
        assert_eq!(TileKind::Rock.base_hp(), 80.0);
    }

    #[test]
    fn solid_iff_not_air() {
        assert!(!TileKind::Air.is_solid());
        for kind in [
            TileKind::Grass,
            TileKind::Dirt,
            TileKind::Stone,
            TileKind::Rock,
        ] {
            assert!(kind.is_solid(), "{kind:?} should be solid");
        }
    }

    #[test]
    fn tile_byte_encoding_round_trips() {
        // docs/06 §6: 0=AIR 1=GRASS 2=DIRT 3=STONE 4=ROCK
        for (kind, byte) in [
            (TileKind::Air, 0),
            (TileKind::Grass, 1),
            (TileKind::Dirt, 2),
            (TileKind::Stone, 3),
            (TileKind::Rock, 4),
        ] {
            assert_eq!(kind.to_byte(), byte);
            assert_eq!(TileKind::from_byte(byte), kind);
        }
        // Out-of-range bytes decode to AIR rather than panicking.
        assert_eq!(TileKind::from_byte(5), TileKind::Air);
        assert_eq!(TileKind::from_byte(255), TileKind::Air);
    }

    #[test]
    fn new_tile_starts_at_full_hp() {
        assert_eq!(Tile::new(TileKind::Stone).hp, 60.0);
        assert_eq!(Tile::new(TileKind::Grass).hp, 20.0);
        assert_eq!(Tile::AIR.kind, TileKind::Air);
        assert!(!Tile::AIR.is_solid());
    }

    #[test]
    fn tile_size_is_16px() {
        // docs/01 §1.
        assert_eq!(TILE_SIZE, 16.0);
    }
}
