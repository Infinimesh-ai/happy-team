/** Loader for Go-generated conformance vectors (test/vectors/*.json). */

import { readFileSync } from 'node:fs';

export function loadVectors<T>(name: string): T {
  const url = new URL(`../../test/vectors/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as T;
}

export interface VectorMeta {
  generator: string;
  pin: string;
  note: string;
}
