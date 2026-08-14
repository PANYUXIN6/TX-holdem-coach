import {
  coachRuntimeDefinitionV1,
  type CoachRuntimeDefinitionV1,
} from './coach/foundation-definition.js'
import { createRuntimeRegistry } from './foundation/runtime-registry.js'
import type { RuntimeDefinitionMap } from './foundation/runtime-definition.js'
import {
  playerRuntimeDefinitionV1,
  type PlayerRuntimeDefinitionV1,
} from './player/foundation-definition.js'

interface ProductionRuntimeDefinitionMap extends RuntimeDefinitionMap {
  readonly player: PlayerRuntimeDefinitionV1
  readonly coach: CoachRuntimeDefinitionV1
}

export const productionRuntimeRegistry =
  createRuntimeRegistry<ProductionRuntimeDefinitionMap>({
    definitions: [playerRuntimeDefinitionV1, coachRuntimeDefinitionV1],
    currentVersions: Object.freeze({ player: 1, coach: 1 }),
  })
