import {
  coachRuntimeDefinition,
  type CoachRuntimeDefinition,
} from './coach/foundation-definition.js'
import { createRuntimeRegistry } from './foundation/runtime-registry.js'
import type { RuntimeDefinitionMap } from './foundation/runtime-definition.js'
import {
  playerRuntimeDefinition,
  type PlayerRuntimeDefinition,
} from './player/foundation-definition.js'

interface ProductionRuntimeDefinitionMap extends RuntimeDefinitionMap {
  readonly player: PlayerRuntimeDefinition
  readonly coach: CoachRuntimeDefinition
}

export const productionRuntimeRegistry =
  createRuntimeRegistry<ProductionRuntimeDefinitionMap>({
    definitions: {
      player: playerRuntimeDefinition,
      coach: coachRuntimeDefinition,
    },
  })
