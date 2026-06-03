// Cubic bezier interpolation. Vendored + ported from Lqm1/x-client-transaction-id (MIT).
// Strict-mode-safe (destructured control points) but mathematically identical to upstream.

export default class Cubic {
  private curves: number[];

  constructor(curves: number[]) {
    this.curves = curves;
  }

  getValue(time: number): number {
    const [c0 = 0, c1 = 0, c2 = 0, c3 = 0] = this.curves;
    let startGradient = 0;
    let endGradient = 0;
    let start = 0.0;
    let mid = 0.0;
    const endInit = 1.0;
    let end = endInit;

    if (time <= 0.0) {
      if (c0 > 0.0) {
        startGradient = c1 / c0;
      } else if (c1 === 0.0 && c2 > 0.0) {
        startGradient = c3 / c2;
      }
      return startGradient * time;
    }

    if (time >= 1.0) {
      if (c2 < 1.0) {
        endGradient = (c3 - 1.0) / (c2 - 1.0);
      } else if (c2 === 1.0 && c0 < 1.0) {
        endGradient = (c1 - 1.0) / (c0 - 1.0);
      }
      return 1.0 + endGradient * (time - 1.0);
    }

    while (start < end) {
      mid = (start + end) / 2;
      const xEst = this.calculate(c0, c2, mid);
      if (Math.abs(time - xEst) < 0.00001) {
        return this.calculate(c1, c3, mid);
      }
      if (xEst < time) {
        start = mid;
      } else {
        end = mid;
      }
    }
    return this.calculate(c1, c3, mid);
  }

  private calculate(a: number, b: number, m: number): number {
    return 3.0 * a * (1 - m) * (1 - m) * m + 3.0 * b * (1 - m) * m * m + m * m * m;
  }
}
