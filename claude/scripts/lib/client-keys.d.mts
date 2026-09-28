export declare const PROFILE_TS: string
export declare function parseKeys(source: string): Map<string, string>
/** Throws if `profile.ts` exports no such `*_KEY`. */
export declare function key(name: string): string
