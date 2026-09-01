import type { Container } from './container';
import type { AuthContext, Env } from './types';

/** Hono generics shared by every route module. */
export interface AppVariables {
  requestId: string;
  auth: AuthContext | null;
  container: Container;
}

export type AppEnv = {
  Bindings: Env;
  Variables: AppVariables;
};
