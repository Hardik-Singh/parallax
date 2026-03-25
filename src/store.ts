import type {
  BaseObject,
  ObjectKind,
  Relation,
  RelationType,
  RunObject,
} from './types.js';

export interface ParallaxStore {
  getObject(id: string): Promise<BaseObject | undefined>;
  putObject(obj: BaseObject): Promise<void>;
  getRelations(
    type?: RelationType,
    fromId?: string,
    toId?: string,
  ): Promise<Relation[]>;
  putRelation(rel: Relation): Promise<void>;
  getRun(id: string): Promise<RunObject | undefined>;
  putRun(run: RunObject): Promise<void>;
  findByHash(hash: string): Promise<BaseObject | undefined>;
  query(kind: ObjectKind, filter?: Record<string, unknown>): Promise<BaseObject[]>;
}

export { InMemoryParallaxStore } from './store/memory.js';
