import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { hasScope, meQuery } from '../../api/me';
import { useFormat } from '../../lib/useFormat';
import page from '../../routes/Page.module.css';
import { buttonClass } from '../../ui/Button';
import { LoadFailed, LoadingRows } from '../settings/shared';
import { DetailDrawer } from './DetailDrawer';
import { Scorecard } from './Scorecard';
import { overviewQuery, PACE_WORD, sameSelection, type Overview, type ScorecardTab, type Selection } from './api';
import styles from './Overview.module.css';

const route = getRouteApi('/t/$tenant/overview');

const SHADES = [styles.shade0, styles.shade1, styles.shade2, styles.shade3];
const accounts = (n: number) => (n === 1 ? '1 account' : `${n} accounts`);

const TAB_IDS: ScorecardTab[] = ['sellers', 'offers', 'practices'];

/** §9 Overview: the quarter's tiles, pipeline funnel, exits and scorecard. `drawer` is the slot for the detail drawer, which defaults to the real one. */
export function OverviewScreen({ drawer }: { drawer?: (selection: Selection | null, close: () => void) => ReactNode }) {
  const { tenant } = route.useParams();
  const search = route.useSearch();
  const tab = TAB_IDS.find((t) => t === search.tab) ?? 'sellers';
  const me = useQuery(meQuery(tenant));
  const data = useQuery(overviewQuery(tenant));
  const [selected, setSelected] = useState<Selection | null>(null);
  const canConfigure = !!me.data && hasScope(me.data, 'settings:manage');
  const o = data.data;
  return (
    <div className={page.page}>
      <div className={styles.head}>
        <div>
          <h1 className={page.title}>Overview</h1>
          <p className={page.sub}>
            {o
              ? `Where every account is this quarter, and who and what moved it there. ${o.quarter.label}, week ${o.quarter.week} of ${o.quarter.weeks}. Click any number to see what made it up.`
              : 'Where every account is this quarter, and who and what moved it there. Click any number to see what made it up.'}
          </p>
        </div>
        {canConfigure && (
          <Link to="/t/$tenant/settings/$tab" params={{ tenant, tab: 'pipeline-stages' }} className={buttonClass('secondary', 'sm')}>
            Configure stages
          </Link>
        )}
      </div>
      {data.isPending ? (
        <LoadingRows>Loading the overview</LoadingRows>
      ) : data.isError ? (
        <LoadFailed title="The overview didn't load" error={data.error} onRetry={() => void data.refetch()} />
      ) : (
        <Body overview={data.data} selected={selected} open={setSelected} />
      )}
      <Scorecard tenant={tenant} tab={tab} selected={selected} open={setSelected} />
      {(drawer ?? ((s, close) => <DetailDrawer tenant={tenant} selection={s} onClose={close} />))(selected, () => setSelected(null))}
    </div>
  );
}

function Body({ overview: o, selected, open }: { overview: Overview; selected: Selection | null; open: (s: Selection) => void }) {
  const f = useFormat();
  const k = o.kpis;
  const first = o.first_stage.name;
  const won = o.won_stage.name;
  const max = Math.max(1, ...o.stages.map((s) => s.count));
  const width = (count: number) => 22 + 78 * Math.sqrt(count / max);
  const target = (t: number | null) => (t !== null && t > 0 ? t : null);
  return (
    <>
      <ul className={styles.tiles} aria-label="Overview totals">
        <Tile label="Pipeline value" value={f.money(k.pipeline_value_cents)} note={`${accounts(k.pipeline_accounts)} at ${o.opportunity_stage.name}`} on={sameSelection(selected, { key: 'pipeline_value' })} onClick={() => open({ key: 'pipeline_value' })} />
        <Tile label="Won value" value={f.money(k.won_value_cents)} note={`${accounts(k.won_accounts)} ${won.toLowerCase()}`} on={sameSelection(selected, { key: 'won_value' })} onClick={() => open({ key: 'won_value' })} />
        <Tile label={`${first} to ${won}`} value={k.sent_to_won_pct === null ? '–' : `${k.sent_to_won_pct}%`} note="Of accounts that entered this quarter" on={sameSelection(selected, { key: 'sent_to_won' })} onClick={() => open({ key: 'sent_to_won' })} />
        <Tile
          label="Days to win"
          value={k.days_to_win === null ? 'None yet' : f.number(k.days_to_win)}
          note={`Median, ${first.toLowerCase()} to ${won.toLowerCase()}`}
          on={sameSelection(selected, { key: 'days_to_win' })}
          onClick={() => open({ key: 'days_to_win' })}
        />
      </ul>
      <section className={styles.funnel} aria-label="Pipeline">
        <h2 className={styles.sectionTitle}>Pipeline</h2>
        {o.stages.some((s) => target(s.target) !== null) && (
          <p className={styles.marker}>
            <span className={styles.markerLine} aria-hidden="true" /> Where we should be today
          </p>
        )}
        <ul className={styles.bands}>
          {o.stages.map((s, i) => {
            const sel: Selection = { key: 'stage', scope: { stage: s.key } };
            const goal = target(s.target);
            const pct = Math.min(100, goal ? (s.count / goal) * 100 : 0);
            return (
              <li key={s.key}>
                <button type="button" className={`${styles.band} ${s.key === o.won_stage.key ? styles.won : ''}`} aria-pressed={sameSelection(selected, sel)} onClick={() => open(sel)}>
                  <span className={`${styles.bandBar} ${SHADES[Math.min(i, 3)]}`} style={{ width: `${width(s.count)}%` }}>
                    <span>{s.name}</span>
                    <span className={styles.bandCount}>{f.number(s.count)}</span>
                  </span>
                  <span className={styles.bandInfo}>
                    {(i === 0 || s.pct_of_previous !== null) && <span>{i === 0 ? 'Into the pipeline' : `${s.pct_of_previous}% of ${o.stages[i - 1]!.name}`}</span>}
                    {s.value_cents !== null && <span>{f.money(s.value_cents)}</span>}
                    {goal === null ? <span className={styles.muted}>No target set</span> : <span>{`${f.number(s.count)} of ${f.number(goal)}`}</span>}
                    {goal !== null && s.pace && <span className={`${styles.pace} ${styles[s.pace]}`}>{PACE_WORD[s.pace]}</span>}
                  </span>
                  {goal !== null && (
                    <span className={styles.track} aria-hidden="true">
                      <span className={styles.fill} style={{ width: `${pct}%` }} />
                      <span className={styles.paceMark} style={{ left: `${o.quarter.pace_pct}%` }} />
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </section>
      <section className={styles.exits} aria-label="Left the pipeline">
        <h2 className={styles.exitsTitle}>Left the pipeline</h2>
        <ul className={styles.exitList}>
          {o.exits.map((e) => {
            const sel: Selection = { key: 'exit', scope: { stage: e.key } };
            return (
              <li key={e.key}>
                <button type="button" className={styles.exit} aria-pressed={sameSelection(selected, sel)} onClick={() => open(sel)}>
                  <span>{e.name}</span>
                  <span className={styles.exitCount}>{f.number(e.count)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}

function Tile({ label, value, note, on, onClick }: { label: string; value: string; note: string; on: boolean; onClick: () => void }) {
  return (
    <li>
      <button type="button" className={styles.tile} aria-pressed={on} onClick={onClick}>
        <span className={styles.tileLabel}>{label}</span>
        <span className={styles.tileValue}>{value}</span>
        <span className={styles.tileNote}>{note}</span>
      </button>
    </li>
  );
}
