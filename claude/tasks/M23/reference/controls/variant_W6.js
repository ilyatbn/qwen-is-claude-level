// T23.14F F1 (R26's control render): the variant `render.mjs W6` loads — `weaponsonly.js`'s scene, which is
// `controls/F6-weapons.png`. Recipe in `../README.md` ("Re-rendering a control").
import { weaponsOnly } from './weaponsonly.js'
export default () => weaponsOnly()
