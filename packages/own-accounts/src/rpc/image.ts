export * as ImageRpc from "./image.js"

import type { Deps } from "../deps.js"
import { ImageService } from "../image/service.js"
import type { Modules } from "../modules.js"
import type { RpcTypes } from "./types.js"

/**
 * Owner: the image tool (02 §9.6). `image.get` shows the key chain and the subscription accounts as the tool would try
 * them now (labels, the user's switches, used-up marks with OpenAI's code and when it was seen, the tightest limit;
 * never a key). `image.clear` forgets a key's used-up mark after the user topped it up, so the next image asks it
 * again. The setting itself is `policy.set{image}`.
 */
export type Methods = "image.get" | "image.clear"

export function handlers(modules: Modules.All, deps: Deps): RpcTypes.Group<Methods> {
  const service = ImageService.create(deps, modules)
  return {
    "image.get": async () => service.view(),
    "image.clear": async (input) => {
      await service.clear(input.accountID)
      deps.log.info("image_mark_cleared", { accountID: input.accountID })
      return service.view()
    },
  }
}
