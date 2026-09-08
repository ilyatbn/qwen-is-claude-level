export interface RustConstants {
  names(): string[]
  has(name: string): boolean
  /** Throws if `constants.rs` has no such `pub const`. */
  get(name: string): number
}

export declare const CONSTANTS_RS: string
export declare function parseConstants(source: string): RustConstants
export declare function constants(): RustConstants
