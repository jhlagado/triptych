function snapshot(name, bytes) {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("Working disk snapshot requires a name.");
  }
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new Error("Working disk snapshot requires bytes.");
  }
  return { name, bytes: Uint8Array.from(bytes) };
}

export class WorkingDiskPersistence {
  #store;
  #onState;
  #flushCount = 0;
  #pending;
  #draining;

  constructor(store, onState = () => {}) {
    this.#store = store;
    this.#onState = onState;
  }

  async restore() {
    this.#onState({ state: "loading" });
    try {
      const restored = await this.#store.load();
      this.#onState({ state: restored === undefined ? "empty" : "restored" });
      return restored;
    } catch (error) {
      this.#onState({ state: "error", error });
      throw error;
    }
  }

  beginMachine(flushCount) {
    if (!Number.isInteger(flushCount) || flushCount < 0) {
      throw new Error("Flush count must be a non-negative integer.");
    }
    this.#flushCount = flushCount;
  }

  replace(name, bytes) {
    this.#queue(snapshot(name, bytes));
  }

  observeFlush(flushCount, name, exportBytes) {
    if (!Number.isInteger(flushCount) || flushCount < 0) {
      throw new Error("Flush count must be a non-negative integer.");
    }
    if (flushCount === this.#flushCount) return false;
    if (typeof exportBytes !== "function") {
      throw new Error("A new flush requires a disk export function.");
    }
    this.#flushCount = flushCount;
    this.#queue(snapshot(name, exportBytes()));
    return true;
  }

  async drain() {
    await this.#draining;
  }

  #queue(value) {
    this.#pending = value;
    if (this.#draining !== undefined) return;
    this.#draining = this.#run().finally(() => {
      this.#draining = undefined;
      if (this.#pending !== undefined) this.#queue(this.#pending);
    });
  }

  async #run() {
    while (this.#pending !== undefined) {
      const value = this.#pending;
      this.#pending = undefined;
      this.#onState({ state: "saving" });
      try {
        await this.#store.save(value);
        this.#onState({ state: "saved" });
      } catch (error) {
        this.#onState({ state: "error", error });
      }
    }
  }
}
