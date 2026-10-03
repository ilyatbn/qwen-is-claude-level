/**
 * The intro's one clock (M99, T99.03). The picture (`intro.js`), the sound (`../intro-sound.mjs`)
 * and the preview's scrubber all read these numbers, so a beep lands on the frame that flashes
 * because both read the same constant, not because two files agree.
 *
 * Seconds from the first frame. Each beat of the owner's sheet is a shot; `B` lists them.
 */
export const T = {
  capOn: 0.35, // the typed caption starts
  capOff: 5.0, // ...and is gone
  land: 3.4, // touchdown (the boom)
  door: 5.0, // shot 2: the hatch starts to swing
  hatchOpen: 6.5, // the hatch is down, facing the ground (clunk)
  rampOut: 6.7, // the ramp starts to slide out of it
  rampDown: 8.0, // the ramp's foot touches the ground (clunk)
  crew: 8.4, // shot 3: the researchers walk out and down
  tablet: 11.9, // shot 4: over the shoulder, the readings fill in
  reading0: 12.4, // first of four readings; one every `readingGap`
  readingGap: 0.65,
  breath: 15.8, // shot 5: the helmet comes off
  inhale: 17.2, // the long breath in
  hold: 19.4, // held
  exhale: 20.3, // breathed out — nothing happens
  fine: 21.4, // the nod and the thumbs-up
  helmets: 22.8, // shot 6: the others take theirs off
  alarm: 25.2, // shot 7: the tablet flips red and beeps
  twitch: 27.6, // shot 8: the twitching
  turn: 29.8, // shot 9: close on him; he goes black
  black: 30.7, // fully black, eyes ignite
  end: 34.0, // cut to black
}

/**
 * The walk-out. The ramp's length decides how long it takes, so its geometry lives here with
 * the clock (`world.js` builds the ramp from it; the score puts footsteps on it).
 */
export const RAMP = { hingeY: 2.1, hingeZ: 3.78, slope: 0.36 }
RAMP.len = RAMP.hingeY / Math.sin(RAMP.slope) // hinge to foot, foot on the ground
export const CREW = {
  start: (i) => T.rampDown + 0.05 + i * 0.55, // when researcher i steps out onto the ramp
  rampSpeed: 3.0, // m/s down the ramp
  groundSpeed: 2.2, // m/s from its foot to their spot
  turn: 0.6, // s to turn to face where they stand
  stride: 8.5, // walk-cycle radians per second: a footfall every π / stride s
}

/** The beats, for the scrubber's labels and the contact sheet. */
export const B = [
  [0, 'descent'],
  [T.door, 'door'],
  [T.crew, 'crew out'],
  [T.tablet, 'tablet'],
  [T.breath, 'breath'],
  [T.helmets, 'helmets off'],
  [T.alarm, 'alarm'],
  [T.twitch, 'twitch'],
  [T.turn, 'turn'],
]

/** When the alarm beeps (and the tablet's red frame flashes): one soft beep every 0.5 s (owner, 2026-10-03 — was a
 *  harsh two-tone pair). */
export const BEEPS = (() => {
  const out = []
  for (let t = T.alarm + 0.15; t < T.turn - 0.1; t += 0.5) out.push(t)
  return out
})()
