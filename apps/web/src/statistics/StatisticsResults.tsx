import {
  StatisticsMetricDefinitions,
  type HandStatisticsMetrics,
  type StatisticsResponse,
  type StatisticsSubject,
} from '@tx-holdem-coach/contracts'
import { amount, integer } from './adapter.js'
const rates = [
  [
    'vpip',
    'VPIP · 翻前自愿入池率',
    '自愿投入手数',
    '参与者手数',
    '强制盲注不计自愿投入。',
  ],
  [
    'pfr',
    'PFR · 翻前加注率',
    '翻前加注手数',
    '参与者手数',
    '每参与者每手最多计一次。',
  ],
  [
    'threeBet',
    '3-bet · 翻前再加注率',
    '完整再加注次数',
    '合法 3-bet 机会次数',
    '是机会次数，不是所有手数；不包含后续 4-bet 层级。',
  ],
  [
    'wtsd',
    'WTSD · 摊牌率',
    '进入摊牌手数',
    '看到翻牌手数',
    '分母不是总手数或整桌曾发出翻牌的手数。',
  ],
  [
    'wsd',
    'W$SD · 摊牌胜率',
    '摊牌获得正派奖手数',
    '进入摊牌手数',
    '平分池也算获得份额；获派奖不等于该手净盈利。',
  ],
] as const
function Value({
  label,
  value,
  unit,
}: {
  label: string
  value: string
  unit?: string
}) {
  return (
    <div className="statistics-value">
      <dt>{label}</dt>
      <dd>
        {value}
        {unit ? <small>{unit}</small> : null}
      </dd>
    </div>
  )
}
export function HandMetrics({
  metrics,
  subject,
}: {
  metrics: HandStatisticsMetrics
  subject: StatisticsSubject
}) {
  return (
    <>
      <dl className="statistics-totals">
        <Value
          label={subject === 'ai' ? 'AI 参与者手数' : '手牌数'}
          value={integer(metrics.handCount)}
        />
        <Value
          label="所选完成手净盈亏"
          value={amount(metrics.handNetChange)}
          unit="筹码"
        />
      </dl>
      <p className="statistics-note">
        实际牌局数 {integer(metrics.distinctHandCount)}
        。参与者手数按获发底牌的参与者计数；同一牌局可有多个 AI
        样本。净盈亏为所选参与者结束筹码减开始筹码之和。
      </p>
      <div className="statistics-rates">
        {rates.map(([key, title, numerator, denominator, note]) => (
          <article className="statistics-card" key={key}>
            <h3>{title}</h3>
            <p className="statistics-percentage">
              {metrics[key].percentage === null
                ? '—'
                : `${metrics[key].percentage}%`}
            </p>
            {metrics[key].percentage === null ? <p>暂无分母样本</p> : null}
            <p className="statistics-counts">
              {numerator} {integer(metrics[key].numerator)} / {denominator}{' '}
              {integer(metrics[key].denominator)}
            </p>
            <p>{StatisticsMetricDefinitions[key]}</p>
            <p className="statistics-note">{note}</p>
          </article>
        ))}
      </div>
    </>
  )
}
export function StatisticsResults({ data }: { data: StatisticsResponse }) {
  if (data.scope === 'sessions')
    return (
      <section aria-label="已结束场次账务结果">
        <h2>已结束场次账务</h2>
        {data.totals.sessionCount === 0 ? (
          <p role="status">暂无符合条件的已结束场次</p>
        ) : null}
        <p>
          {integer(data.totals.sessionCount)} 个已结束场次，
          {integer(data.totals.participantSessionCount)} 个
          {data.query.subject === 'ai' ? ' AI ' : ''}参与者场次
        </p>
        <dl className="statistics-totals">
          <Value
            label="已结束场次净盈亏"
            value={amount(data.totals.sessionNetChange)}
            unit="筹码"
          />
          <Value
            label="最终筹码"
            value={integer(data.totals.finalChips)}
            unit="筹码"
          />
          <Value
            label="全部买入与补码"
            value={integer(data.totals.cumulativeBuyIn)}
            unit="筹码"
          />
        </dl>
        <p className="statistics-note">
          整场净盈亏 = 最终筹码 − 全部买入与补码；日期按场次结束时间筛选。
        </p>
      </section>
    )
  return (
    <section aria-label="完成手统计结果">
      <h2>完成手总计</h2>
      <p className="statistics-note">
        仅计正常完成手，包含活动场次中此前已完成的手；不含进行中和中止手。日期按手牌开手时间筛选。
      </p>
      {data.totals.handCount === 0 ? (
        <p role="status">暂无符合条件的完成手</p>
      ) : null}
      <HandMetrics metrics={data.totals} subject={data.query.subject} />
      {data.byPosition.length ? (
        <section className="statistics-positions" aria-label="按位置分组">
          <h2>按开手位置</h2>
          <p className="statistics-note">
            各组实际牌局数仅解释该组自身，不跨位置相加。
          </p>
          {data.byPosition.map(({ position, metrics }) => (
            <details className="statistics-card" key={position}>
              <summary>
                {position} ·{' '}
                {metrics.handCount
                  ? `${integer(metrics.handCount)} 参与者手数`
                  : '无样本'}
                <span>净盈亏 {amount(metrics.handNetChange)} 筹码</span>
              </summary>
              <HandMetrics metrics={metrics} subject={data.query.subject} />
            </details>
          ))}
        </section>
      ) : null}
    </section>
  )
}
