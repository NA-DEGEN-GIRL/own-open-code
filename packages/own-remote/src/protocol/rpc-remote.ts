/**
 * RPC `own.remote` (04 §16) lives in `@own/protocol/rpc-remote` (04 §16.1, §21 R0). This module re-exports it so
 * own-remote code keeps one import path.
 */
export { OwnRemote } from "@own/protocol/rpc-remote"
