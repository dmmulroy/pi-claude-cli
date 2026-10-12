/**
 * Node implementations of the platform services the provider uses.
 *
 * Imported from `@effect/platform-node-shared`'s narrow entrypoints, never
 * its barrel: the barrel also loads the socket, cluster and `ws` modules,
 * which costs every pi session about 80 ms and 25 MB for nothing.
 */

import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import * as NodePath from "@effect/platform-node-shared/NodePath";
import { Layer } from "effect";

/** Node `FileSystem` and `Path`. */
export const nodeFileSystemLayer = Layer.mergeAll(
  NodeFileSystem.layer,
  NodePath.layer,
);
