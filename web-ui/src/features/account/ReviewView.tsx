import { useQuery } from '@tanstack/react-query';
import type { Me } from '../../api/me';
import { cx } from '../../lib/cx';
import { useFormat } from '../../lib/useFormat';
import { Card } from '../../ui/Card';
import type { AccountReview } from '../review/api';
import { errorText } from '../settings/shared';
import { briefQuery, factsQuery, scoreQuery, type AccountDetail, type Fact } from './api';
import { BriefCard, notDrafted, Recommendation } from './BriefCard';
import styles from './Account.module.css';
import { BuyingCommittee, InHubSpot, Notes, WhereFrom } from './RightRail';
import { ScoreStrip } from './ScoreStrip';

export type ViewProps = { tenant: string; me: Me; account: AccountDetail; review: AccountReview };

/** The dashed card before Scout's first draft (§4 States, Building). */
function Building({ tenant, id }: { tenant: string; id: string }) {
  const brief = useQuery(briefQuery(tenant, id));
  if (!brief.data || !notDrafted(brief.data)) return null;
  return (
    <div className={styles.building}>
      <h2 className={styles.sectionTitle}>Scout is still building this brief</h2>
      <p className={styles.note}>
        Scores, dated signals and the brief appear here as enrichment finishes. You can decide now with what the source sent, or run Enrich to search
        procurement portals, news, filings and job posts first.
      </p>
    </div>
  );
}

/** §4a 2. Before you approve: in R1 only the warm intro row; no card without one. */
function BeforeYouApprove({ tenant, id }: { tenant: string; id: string }) {
  const score = useQuery(scoreQuery(tenant, id));
  const name = score.data?.warm_intro?.introducer_name;
  if (!name) return null;
  return (
    <Card title="Before you approve">
      <p className={styles.dotRow}>{`Warm intro available through ${name}.`}</p>
    </Card>
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/** §4a 4. Why now: dated signals, newest first, each with its date, text and source link. */
export function WhyNow({ account }: { account: AccountDetail }) {
  const f = useFormat();
  const dated = account.signals.filter((s) => s.occurred_at);
  return (
    <Card
      title="Why now"
      actions={dated.length > 0 ? <span className={cx(styles.muted, styles.small)}>{`${dated.length === 1 ? '1 signal' : `${dated.length} signals`} · newest first`}</span> : undefined}
    >
      {dated.length === 0 ? (
        <p className={styles.note}>No dated signals yet. Signals show here with their date and a link to where Scout found them.</p>
      ) : (
        <ul className={styles.rows}>
          {dated.map((s) => (
            <li key={s.id}>
              <span className={styles.when}>{f.date(s.occurred_at!)}</span>
              <span className={styles.stack}>
                <span>{s.title}</span>
                {s.detail && <span className={styles.muted}>{s.detail}</span>}
                {s.url && (
                  <a href={s.url} target="_blank" rel="noreferrer" className={styles.small}>
                    {s.source_name ?? hostOf(s.url)}
                  </a>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function useFactValue() {
  const f = useFormat();
  return (v: unknown): string => {
    if (typeof v === 'number') return f.number(v);
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(String).join(', ');
    return v === null || v === undefined ? 'None' : JSON.stringify(v);
  };
}

const sourceOf = (x: Fact) => x.source_names.vendor ?? x.source_names.agent ?? x.source_names.person;

/** §4a 5. Account facts: label, value and "{source} · {date}". No conflict badge in R1. */
export function AccountFacts({ tenant, id }: { tenant: string; id: string }) {
  const f = useFormat();
  const value = useFactValue();
  const facts = useQuery(factsQuery(tenant, id));
  const rows = (facts.data?.data ?? []).filter((x) => x.person_id === null);
  return (
    <Card title="Account facts">
      {facts.isPending ? (
        <p className={styles.note}>Loading facts</p>
      ) : facts.isError ? (
        <p className={styles.error} role="alert">{`Facts didn't load. ${errorText(facts.error)}`}</p>
      ) : rows.length === 0 ? (
        <p className={styles.note}>No facts yet. Facts show here as sources send them.</p>
      ) : (
        <dl className={styles.rows}>
          {rows.map((x) => (
            <div key={x.id} className={styles.fact}>
              <dt className={styles.factLabel}>{x.label}</dt>
              <dd className={styles.stack}>
                <span>{value(x.value)}</span>
                <span className={cx(styles.muted, styles.small)}>{[sourceOf(x), f.date(x.observed_at)].filter(Boolean).join(' · ')}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  );
}

/** §4a: the decision first, then scores, signals, facts and the brief; the rail on the right. */
export function ReviewView({ tenant, me, account, review }: ViewProps) {
  return (
    <div className={styles.layout}>
      <div className={styles.main}>
        <Building tenant={tenant} id={account.id} />
        <Recommendation tenant={tenant} id={account.id} />
        <BeforeYouApprove tenant={tenant} id={account.id} />
        <ScoreStrip tenant={tenant} id={account.id} />
        <WhyNow account={account} />
        <AccountFacts tenant={tenant} id={account.id} />
        <BriefCard tenant={tenant} me={me} id={account.id} />
      </div>
      <aside className={styles.rail} aria-label="Account details">
        <BuyingCommittee tenant={tenant} me={me} account={account} />
        <Notes tenant={tenant} id={account.id} />
        <WhereFrom review={review} />
        <InHubSpot tenant={tenant} me={me} id={account.id} />
      </aside>
    </div>
  );
}
