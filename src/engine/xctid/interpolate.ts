// Array/scalar interpolation. Vendored + ported from Lqm1/x-client-transaction-id (MIT).
import { InterpolationInputError } from './errors.ts';

export function interpolate(fromList: number[], toList: number[], f: number): number[] {
  if (fromList.length !== toList.length) {
    throw new InterpolationInputError(fromList.length, toList.length);
  }
  const out: number[] = [];
  for (let i = 0; i < fromList.length; i++) {
    out.push(interpolateNum(fromList[i] ?? 0, toList[i] ?? 0, f));
  }
  return out;
}

export function interpolateNum(
  fromVal: number | boolean,
  toVal: number | boolean,
  f: number,
): number {
  if (typeof fromVal === 'number' && typeof toVal === 'number') {
    return fromVal * (1 - f) + toVal * f;
  }
  if (typeof fromVal === 'boolean' && typeof toVal === 'boolean') {
    return f < 0.5 ? (fromVal ? 1 : 0) : toVal ? 1 : 0;
  }
  return 0;
}
