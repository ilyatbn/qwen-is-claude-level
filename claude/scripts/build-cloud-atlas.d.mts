export interface CloudSource {
  colour: 'white' | 'gray' | 'black'
  shape: number
  size: number
  frame: string
  file: string
}

export declare const PACK_ROOT: string
export declare const COLOURS: Record<string, 'white' | 'gray' | 'black'>
export declare function selectClouds(packRoot?: string): CloudSource[]
