/** T23.01: the reference scenes F1–F5 as data, by id (`?look=F1` will read this). */
import type { SceneData } from '../scene'
import { F1 } from './F1'
import { F2 } from './F2'
import { F3 } from './F3'
import { F4 } from './F4'
import { F5 } from './F5'

export const SCENES: Record<string, SceneData> = { F1, F2, F3, F4, F5 }
