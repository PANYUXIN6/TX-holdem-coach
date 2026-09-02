import { runPlayerDeterministicEval } from './player-deterministic-eval-runner.ts'

const result = runPlayerDeterministicEval()

process.stdout.write(
  `${JSON.stringify({
    category: 'player_deterministic_eval_passed',
    scenarioCount: result.scenarioCount,
    fingerprint: result.fingerprint,
  })}\n`,
)
