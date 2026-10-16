export class DurableObject<Env = unknown> {
  constructor(protected ctx: unknown, protected env: Env) {}
}
