/**
 * A damped spring pulling a point towards a target, stepped once per frame: what makes the pill and the
 * card trail the pointer a little while dragged, and glide (thrown, overshooting a touch) to where they
 * settle. The same spring as the Android bubble's (android/…/Spring.kt).
 */
export class Spring {
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  toX = 0;
  toY = 0;

  /** stiffness: natural frequency squared, 1/s²; damping: the damping ratio (under 1: a small overshoot). */
  constructor(
    public stiffness: number,
    public damping = 0.72,
  ) {}

  /** Stands still at (x, y). */
  reset(x: number, y: number): void {
    this.x = this.toX = x;
    this.y = this.toY = y;
    this.vx = this.vy = 0;
  }

  /** Moves on by `dt` seconds (capped, so a stalled frame doesn't throw it far). */
  step(dt: number): void {
    const t = Math.min(dt, 1 / 20);
    [this.x, this.vx] = this.solve(this.x - this.toX, this.vx, t, this.toX);
    [this.y, this.vy] = this.solve(this.y - this.toY, this.vy, t, this.toY);
  }

  /** At the target and all but still. */
  get resting(): boolean {
    return Math.abs(this.toX - this.x) < 0.5 && Math.abs(this.toY - this.y) < 0.5 && Math.abs(this.vx) < 20 && Math.abs(this.vy) < 20;
  }

  /** Exact solution of the underdamped spring over `t`, so a long frame can't make it blow up. */
  private solve(offset: number, velocity: number, t: number, to: number): [number, number] {
    const w0 = Math.sqrt(this.stiffness);
    const z = this.damping;
    const wd = w0 * Math.sqrt(1 - z * z);
    const a = offset;
    const b = (velocity + z * w0 * offset) / wd;
    const decay = Math.exp(-z * w0 * t);
    const cos = Math.cos(wd * t);
    const sin = Math.sin(wd * t);
    return [to + decay * (a * cos + b * sin), decay * ((b * wd - z * w0 * a) * cos - (a * wd + z * w0 * b) * sin)];
  }
}
