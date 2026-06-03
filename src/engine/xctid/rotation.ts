// Rotation → 2D transform matrix. Vendored + ported from Lqm1/x-client-transaction-id (MIT).

/** Converts a rotation angle in degrees to a [a, b, c, d] transform matrix. */
export function convertRotationToMatrix(rotation: number): number[] {
  const rad = (rotation * Math.PI) / 180;
  return [Math.cos(rad), -Math.sin(rad), Math.sin(rad), Math.cos(rad)];
}
