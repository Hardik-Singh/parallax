import type {
  BaseObject,
  ObjectKind,
  Relation,
  RelationType,
  RunObject,
} from '../types.js';
import type { ParallaxStore } from '../store.js';

export class InMemoryParallaxStore implements ParallaxStore {
  private objects = new Map<string, BaseObject>();
  private relations: Relation[] = [];
  private runs = new Map<string, RunObject>();

  async getObject(id: string): Promise<BaseObject | undefined> {
    return this.objects.get(id);
  }

  async putObject(obj: BaseObject): Promise<void> {
    this.objects.set(obj.id, obj);
    // Also store as a run if it is one
    if (obj.kind === 'Run') {
      this.runs.set(obj.id, obj as RunObject);
    }
  }

  async getRelations(
    type?: RelationType,
    fromId?: string,
    toId?: string,
  ): Promise<Relation[]> {
    return this.relations.filter((r) => {
      if (type && r.type !== type) return false;
      if (fromId && r.from !== fromId) return false;
      if (toId && r.to !== toId) return false;
      return true;
    });
  }

  async putRelation(rel: Relation): Promise<void> {
    // Deduplicate: same id means same relation
    const existing = this.relations.findIndex((r) => r.id === rel.id);
    if (existing >= 0) {
      this.relations[existing] = rel;
    } else {
      this.relations.push(rel);
    }
  }

  async getRun(id: string): Promise<RunObject | undefined> {
    return this.runs.get(id);
  }

  async putRun(run: RunObject): Promise<void> {
    this.runs.set(run.id, run);
    this.objects.set(run.id, run);
  }

  async findByHash(hash: string): Promise<BaseObject | undefined> {
    // Object ids ARE content hashes, so lookup by id
    return this.objects.get(hash);
  }

  async query(
    kind: ObjectKind,
    filter?: Record<string, unknown>,
  ): Promise<BaseObject[]> {
    const results: BaseObject[] = [];
    for (const obj of this.objects.values()) {
      if (obj.kind !== kind) continue;
      if (filter) {
        let matches = true;
        for (const [key, value] of Object.entries(filter)) {
          if ((obj as unknown as Record<string, unknown>)[key] !== value) {
            matches = false;
            break;
          }
        }
        if (!matches) continue;
      }
      results.push(obj);
    }
    return results;
  }
}
