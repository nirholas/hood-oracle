import type { EngineEvent, EventBusApi } from '../types.js'

/**
 * In-process event bus. The engine emits, the API streams to SSE clients and
 * the journal persists. A bounded ring buffer lets a dashboard that connects
 * late replay the last few minutes instead of staring at an empty tape.
 */
export class EventBus implements EventBusApi {
  private readonly listeners = new Set<(e: EngineEvent) => void>()
  private readonly ring: EngineEvent[] = []

  constructor(private readonly capacity = 500) {}

  emit(event: EngineEvent): void {
    this.ring.push(event)
    if (this.ring.length > this.capacity) this.ring.splice(0, this.ring.length - this.capacity)
    for (const fn of this.listeners) {
      try {
        fn(event)
      } catch {
        // a broken listener never takes the engine down
      }
    }
  }

  subscribe(fn: (e: EngineEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  recent(limit = 200): EngineEvent[] {
    return this.ring.slice(-limit)
  }
}
