export class ProxyProvider {
  private proxies: string[] = [];
  private index = 0;

  constructor() {
    // Read from process.env instead of config, since it's local to the renderer
    const raw = process.env.RESIDENTIAL_PROXIES ?? "";
    this.proxies = raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  /**
   * Returns a proxy URL (e.g. "http://user:pass@ip:port") in a round-robin fashion.
   * If no proxies are configured, returns null (meaning use local IP).
   */
  getProxy(): string | null {
    if (this.proxies.length === 0) return null;
    const proxy = this.proxies[this.index % this.proxies.length];
    this.index += 1;
    return proxy ?? null;
  }
}
