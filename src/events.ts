import type { ParallaxEventType } from './types.js';

export type EventHandler = (data: unknown) => void;

export class EventRegistry {
  private handlers = new Map<ParallaxEventType, EventHandler[]>();

  on(event: ParallaxEventType, handler: EventHandler): void {
    const existing = this.handlers.get(event) ?? [];
    existing.push(handler);
    this.handlers.set(event, existing);
  }

  emit(event: ParallaxEventType, data: unknown): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        handler(data);
      }
    }
  }
}
