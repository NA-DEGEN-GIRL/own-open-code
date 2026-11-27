import { Permission } from "@opencode/core/permission"
import { Effect, Layer } from "effect"

export const permissionLayer = (overrides: Partial<Permission.Interface> = {}) =>
  // OWN-PATCH(P-031) begin
  Layer.mock(Permission.Service, {
    close: Effect.void,
    nested: () => Effect.void,
    check: () => Effect.succeed("allow" as const),
    ...overrides,
  })
// OWN-PATCH(P-031) end

export const permissionService = (overrides: Partial<Permission.Interface> = {}) =>
  Effect.runSync(
    Effect.gen(function* () {
      return yield* Permission.Service
    }).pipe(Effect.provide(permissionLayer(overrides))),
  )
