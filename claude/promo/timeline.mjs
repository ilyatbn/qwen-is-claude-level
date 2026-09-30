/**
 * The trailer's one clock (M99). The music is written to it and the edit cuts to it, so a
 * cut lands on a beat because both read the same numbers, not because two files agree.
 *
 * 150 BPM: a beat is 0.4 s, a bar 1.6 s.
 */
export const BPM = 150
export const BEAT = 60 / BPM
export const BAR = BEAT * 4
export const FPS = 60
export const W = 1920
export const H = 1080

/** Section starts, seconds. */
export const T = {
  intro: 0, // the prequel: landing, the breath, the turn
  land: 3.2, // the lander touches down (a boom in the score)
  inhale: 8.8, // the close-up: a breath of alien air
  exhale: 11.6,
  turn: 12.4, // he goes black
  drop: BAR * 9, // 14.4 — the riff starts, the game starts
  riser: BAR * 25, // 40.0 — the build to the title
  title: BAR * 27, // 43.2 — SHRED
  soon: BAR * 31, // 49.6 — COMING SOON
  end: BAR * 35, // 56.0 — the last chord
  tail: BAR * 35 + 3.0, // 59.0 — ring-out, black
}

/** Taglines over the gameplay, [start, end, text]. */
export const LINES = [
  [T.drop + BAR * 4, T.drop + BAR * 5.5, 'TRUST NO ONE'],
  [T.drop + BAR * 9, T.drop + BAR * 10.5, 'THE WHOLE WORLD IS A WEAPON'],
  [T.drop + BAR * 13, T.drop + BAR * 14.5, 'LAST ONE BREATHING'],
]
