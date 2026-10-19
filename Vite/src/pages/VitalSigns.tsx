import { useEffect, useState } from 'react';
import NavigationBar from '../components/NavigationBar';
import VitalTrendChart from '../components/VitalTrendChart';
import { api, type VitalCard, type VitalType } from '../api';

type BmiInfo = { category: string | null; note: string | null; age: number | null };
type BmiToday = { measured_at?: string; source?: string; bmi_info?: BmiInfo };
type HistoryRow = {
  vital_log_id: string; vital_type: string; value_numeric: number; value_secondary: number | null;
  unit: string | null; measured_at: string; source: string | null; bmi_info?: BmiInfo;
};
const dateOf = (iso?: string) => (iso ? new Date(iso).toLocaleDateString() : '');
const sourceLabel = (source?: string | null) => (source === 'calculated' ? 'Calculated' : '');

function BmiCard({ card, bucket }: { card: VitalCard; bucket: 'day' | 'month' }) {
  const today = card.today as (VitalCard['today'] & BmiToday) | null;
  const info = today?.bmi_info;
  return <article className="feature-card">
    <h3>{card.display_name}</h3>
    <strong className="vital-value">{today ? `${today.value} ${today.unit || card.unit}` : 'No reading'}</strong>
    {today && <>
      <p>Latest: {dateOf(today.measured_at)} ({today.age_label})</p>
      {today.source === 'calculated' && <p><strong>Calculated</strong> from your weight and height</p>}
      <p className={`range-status ${today.evaluation.status}`}>{today.evaluation.status.replaceAll('_', ' ')} · {today.evaluation.range.source.replaceAll('_', ' ')}</p>
      {info?.category && <p>Category (adults): {info.category}</p>}
      {info && !info.category && info.note && <p>{info.note}</p>}
    </>}
    <VitalTrendChart card={card} bucket={bucket} />{card.change && <p>Change: {card.change.delta > 0 ? '+' : ''}{card.change.delta} {card.unit} ({card.change.direction})</p>}
  </article>;
}

function VitalSigns() {
  const [types, setTypes] = useState<VitalType[]>([]);
  const [cards, setCards] = useState<VitalCard[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [selected, setSelected] = useState('');
  const [value, setValue] = useState('');
  const [secondary, setSecondary] = useState('');
  const [measured, setMeasured] = useState('');
  const [range, setRange] = useState('month');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [removing, setRemoving] = useState('');
  const type = types.find(t => t.vital_type === selected);

  async function refresh(period: string) {
    const [result, recent] = await Promise.all([
      api<{ cards: VitalCard[] }>(`/vitals/quick-look?range=${period}`), api<{ readings: HistoryRow[] }>('/vitals?limit=25'),
    ]);
    setCards(result.cards); setHistory(recent.readings);
  }
  useEffect(() => {
    Promise.all([api<{ types: VitalType[] }>('/vitals/types'), api<{ cards: VitalCard[] }>(`/vitals/quick-look?range=${range}`), api<{ readings: HistoryRow[] }>('/vitals?limit=25')])
      .then(([t, c, h]) => { setTypes(t.types); setSelected(t.types[0]?.vital_type || ''); setCards(c.cards); setHistory(h.readings); })
      .catch(e => setError(e.message)).finally(() => setLoading(false));
  }, []);

  async function record(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    try {
      if (!selected || !Number.isFinite(Number(value)) || value === '') throw new Error('Choose a type and enter a reading.');
      const saved = await api<{ bmi?: { action: string; reason?: string } }>('/vitals', { method: 'POST', body: JSON.stringify({
        vital_type: selected, value_numeric: Number(value),
        ...(type?.is_dual_value ? { value_secondary: Number(secondary) } : {}),
        ...(measured ? { measured_at: new Date(measured).toISOString() } : {}),
      }) });
      await refresh(range); setValue(''); setSecondary(''); setMeasured('');
      setMessage(saved.bmi?.action === 'created' ? 'Reading saved. BMI was calculated from your weight and height.'
        : saved.bmi?.reason ? `Reading saved. BMI was not calculated: ${saved.bmi.reason}` : 'Reading saved.');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function removeReading(r: HistoryRow) {
    const affectsBmi = r.vital_type === 'weight' || r.vital_type === 'height';
    if (!window.confirm(affectsBmi ? 'Remove this reading? Its calculated BMI will also be removed.' : "Remove this reading? This can't be undone.")) return;
    setRemoving(r.vital_log_id); setError(''); setMessage('');
    try {
      await api(`/vitals/${r.vital_log_id}`, { method: 'DELETE' });
      await refresh(range); setMessage('Reading removed.');
    } catch (e) { setError((e as Error).message); }
    finally { setRemoving(''); }
  }

  async function changeRange(next: string) {
    setRange(next); setLoading(true); setError('');
    try { await refresh(next); } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }
  return <><NavigationBar /><main className="page-container feature-page">
    <h2>Vital Signs</h2><p>Log readings and review changes over time. Range indicators use the backend’s reference or personal target values.</p>
    {error && <p className="notice error" role="alert">{error}</p>}{message && <p className="notice success" role="status">{message}</p>}
    <form className="feature-card feature-form" onSubmit={record}><h3>Record a reading</h3>
      <label>Vital sign<select required value={selected} onChange={e => { setSelected(e.target.value); setValue(''); setSecondary(''); }}>{types.map(t => <option key={t.vital_type} value={t.vital_type}>{t.display_name}</option>)}</select></label>
      <label>{type?.value_label || 'Value'} {type && `(${type.default_unit})`}<input type="number" step="any" required value={value} onChange={e => setValue(e.target.value)} /></label>
      {type?.is_dual_value && <label>{type.secondary_label || 'Second value'}<input type="number" step="any" required value={secondary} onChange={e => setSecondary(e.target.value)} /></label>}
      <label>Measured at (optional)<input type="datetime-local" value={measured} onChange={e => setMeasured(e.target.value)} title="Leave blank to use the current time" /></label>
      <button className="primary-button" disabled={busy || !types.length}>{busy ? 'Saving…' : 'Save reading'}</button>
      <p className="form-hint">Leave “Measured at” blank to use the current time.</p>
    </form>
    <div className="filter-row"><label>Time period<select value={range} onChange={e => changeRange(e.target.value)}><option value="week">Past week</option><option value="month">Past month</option><option value="year">Past year</option><option value="all">All time</option></select></label></div>
    {loading ? <p role="status">Loading vital signs…</p> : cards.length === 0 ? <p>No readings yet. Record one above to begin tracking.</p> : <div className="feature-grid">{cards.map(card => card.vital_type === 'bmi' ? <BmiCard key={card.vital_type} card={card} bucket={range === 'year' || range === 'all' ? 'month' : 'day'} /> : <article className="feature-card" key={card.vital_type}>
      <h3>{card.display_name}</h3><strong className="vital-value">{card.today ? `${card.today.value}${card.today.secondary != null ? `/${card.today.secondary}` : ''} ${card.today.unit || card.unit}` : 'No reading'}</strong>
      {card.today && <><p>Latest: {card.today.age_label}</p><p className={`range-status ${card.today.evaluation.status}`}>{card.today.evaluation.status.replaceAll('_', ' ')} · {card.today.evaluation.range.source.replaceAll('_', ' ')}</p></>}
      <VitalTrendChart card={card} bucket={range === 'year' || range === 'all' ? 'month' : 'day'} />{card.change && <p>Change: {card.change.delta > 0 ? '+' : ''}{card.change.delta} {card.unit} ({card.change.direction})</p>}
    </article>)}</div>}
    {history.length > 0 && <section className="feature-card" aria-labelledby="vital-history-heading"><h3 id="vital-history-heading">Recent readings</h3>
      <table className="access-log"><thead><tr><th scope="col">Date</th><th scope="col">Vital sign</th><th scope="col">Reading</th><th scope="col">Source</th><th scope="col">Actions</th></tr></thead>
        <tbody>{history.map(r => <tr key={r.vital_log_id}>
          <td>{dateOf(r.measured_at)}</td>
          <td>{types.find(t => t.vital_type === r.vital_type)?.display_name || r.vital_type.replaceAll('_', ' ')}</td>
          <td>{r.value_numeric}{r.value_secondary != null ? `/${r.value_secondary}` : ''} {r.unit || ''}{r.vital_type === 'bmi' && r.bmi_info?.category ? ` (${r.bmi_info.category})` : ''}</td>
          <td>{sourceLabel(r.source)}</td>
          <td>{r.source === 'calculated' ? <span className="form-hint">Calculated from weight and height. Remove the weight or height reading to change it.</span>
            : <button type="button" className="secondary-button" disabled={removing === r.vital_log_id}
              aria-label={`Delete ${(types.find(t => t.vital_type === r.vital_type)?.display_name || r.vital_type.replaceAll('_', ' ')).toLowerCase()} reading from ${r.measured_at.slice(0, 10)}`}
              onClick={() => removeReading(r)}>{removing === r.vital_log_id ? 'Deleting…' : 'Delete'}</button>}</td>
        </tr>)}</tbody></table>
      <p className="form-hint">BMI categories are for adults age 20 and older. For children and teens, ask your doctor to compare BMI with growth charts for your age and sex.</p>
    </section>}
  </main></>;
}
export default VitalSigns;
