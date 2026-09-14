import type {
  Card,
  HandHistoryResponse,
  PokerAction,
} from '@tx-holdem-coach/contracts'
import { Avatar, ChipAmount, PlayingCard } from '../components/identity.js'
import { actionLabel, signed } from './presentation.js'
import { streetLabel } from '../table/presentation.js'

export function Cards({ cards }: { cards: readonly Card[] | null }) {
  return (
    <div className="history-cards">
      {cards === null ? (
        <>
          <PlayingCard state="back" />
          <PlayingCard state="back" />
          <span>未公开</span>
        </>
      ) : (
        cards.map((card, index) => (
          <PlayingCard key={index} state="face" card={card} />
        ))
      )}
    </div>
  )
}
export type FlowAction = {
  eventSeq: number
  actionNumber: number
  name: string
  position?: string | undefined
  action: PokerAction
  display?:
    | { committedAmount: number; streetContributionAfterAction: number }
    | undefined
  stack?: number | undefined
  pot: number
  potBefore?: number
}
export function StreetFlow({
  phase,
  cards,
  actions,
}: {
  phase: keyof typeof streetLabel
  cards: readonly Card[]
  actions: FlowAction[]
}) {
  return (
    <section className="history-panel">
      <h3>{streetLabel[phase]}</h3>
      <Cards cards={cards} />
      {actions.length ? (
        <ol className="history-actions">
          {actions.map((action) => (
            <li key={action.eventSeq}>
              <div className="history-action-heading">
                <span className="history-number">
                  {action.actionNumber.toString().padStart(2, '0')}
                </span>
                <strong>{action.name}</strong>
                <span>{action.position ?? '位置待校准'}</span>
              </div>
              <p className="history-action-amount">
                {actionLabel(action.action, action.display)}
              </p>
              <p>
                {action.display
                  ? `本街累计 ${action.display.streetContributionAfterAction}`
                  : '投入详情待校准'}{' '}
                · 行动后筹码 {action.stack ?? '待校准'} · 底池 {action.pot}
              </p>
              {action.potBefore !== undefined ? (
                <details>
                  <summary>金额明细</summary>
                  <p>
                    行动前底池 {action.potBefore} · 本次投入{' '}
                    {action.display?.committedAmount}
                  </p>
                </details>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p>本街无下注行动</p>
      )}
    </section>
  )
}
export function CompletedFlow({ data }: { data: HandHistoryResponse }) {
  const { history } = data
  const result = history.phases.find((phase) => phase.phase === 'showdown')!
  const participant = (seat: number) =>
    history.participants.find((p) => p.seatNumber === seat)!
  return (
    <>
      <section className="history-panel">
        <h2>第 {history.handNumber} 手</h2>
        <Cards
          cards={
            result.revealedHands.find((hand) => hand.seatNumber === 0)
              ?.holeCards ?? null
          }
        />
        <Cards cards={result.communityCards} />
        <p>{new Date(history.startedAt).toLocaleString()}</p>
        <p>
          用户净变化 {signed(participant(0).netChange)} · 结束筹码{' '}
          {participant(0).endingStack}
        </p>
      </section>
      {history.phases.map((phase) =>
        phase.phase !== 'showdown' ? (
          <StreetFlow
            key={phase.phase}
            phase={phase.phase}
            cards={phase.communityCards}
            actions={phase.actions.map((action) => ({
              eventSeq: action.eventSeq,
              actionNumber: action.actionNumber,
              name: participant(action.actorSeatNumber).displayName,
              position: action.position,
              action: action.action,
              display: action,
              stack: action.stackAfterAction,
              pot: action.potAfterAction,
              potBefore: action.potBeforeAction,
            }))}
          />
        ) : (
          <section className="history-panel" key={phase.phase}>
            <h3>
              {phase.terminationReason === 'complete'
                ? '结算（其余玩家弃牌）'
                : '摊牌 / 结算'}
            </h3>
            <Cards cards={phase.communityCards} />
            {phase.uncalledBetReturns.map((item) => (
              <p key={item.eventSeq}>
                未跟注返还 · {participant(item.seatNumber).displayName}{' '}
                <ChipAmount amount={item.amount} />
              </p>
            ))}
            {phase.pots.map((pot) => (
              <section className="history-pot" key={pot.potIndex}>
                <h4>
                  {pot.kind === 'main' ? '主池' : `边池 ${pot.potIndex}`} ·{' '}
                  <ChipAmount amount={pot.amount} />
                </h4>
                <p>
                  赢家：
                  {pot.winningSeatNumbers
                    .map((seat) => participant(seat).displayName)
                    .join('、')}
                </p>
                {pot.awards.map((award) => (
                  <p key={award.seatNumber}>
                    {participant(award.seatNumber).displayName} · 派奖{' '}
                    {award.amount}
                  </p>
                ))}
              </section>
            ))}
            {phase.revealedHands.map((hand) => {
              const player = participant(hand.seatNumber)
              return (
                <section className="history-player" key={hand.seatNumber}>
                  <h4>
                    <Avatar
                      displayName={player.displayName}
                      avatarColor={player.avatarColor}
                      size={32}
                      decorative
                    />
                    {player.displayName} · {player.position}
                  </h4>
                  <Cards cards={hand.holeCards} />
                  <p>
                    结束筹码 {player.endingStack} · 净变化{' '}
                    {signed(player.netChange)}
                  </p>
                  {hand.handEvaluation ? (
                    <>
                      <p>
                        {
                          {
                            highCard: '高牌',
                            onePair: '一对',
                            twoPair: '两对',
                            threeOfAKind: '三条',
                            straight: '顺子',
                            flush: '同花',
                            fullHouse: '葫芦',
                            fourOfAKind: '四条',
                            straightFlush: '同花顺',
                          }[hand.handEvaluation.category]
                        }
                      </p>
                      <Cards cards={hand.handEvaluation.bestFive} />
                    </>
                  ) : (
                    <p>
                      {hand.holeCards === null
                        ? '牌型未公开'
                        : '未进行摊牌评估'}
                    </p>
                  )}
                </section>
              )
            })}
          </section>
        ),
      )}
    </>
  )
}
