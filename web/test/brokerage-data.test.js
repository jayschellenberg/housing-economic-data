import { describe, it, expect } from 'vitest';
import {
  seriesIndex, publishersFor, areasFor, totalLines, cardInput, latestTable, periodLabel, coverage, years,
  unitOfMetric, fmtValue, areaLabel, isForecast,
} from '../src/brokerage-data.js';

const obs = (publisher, sector, period, geo, segment, metric, value, flag = '') => ({
  publisher, sector, period, date: period.length === 4 ? `${period}-12-31` : `${period.slice(0, 4)}-${['03-31', '06-30', '09-30', '12-31'][Number(period.slice(-1)) - 1]}`,
  geo, segment, metric, value, unit: 'pct', src: 's1', page: 1, flag,
});

const data = {
  sources: [
    { id: 's1', publisher: 'Capital Group', sector: 'industrial', period: '2026Q1', file: 'a.pdf', folder: 'x' },
    { id: 's2', publisher: 'Capital Group', sector: 'industrial', period: '2026Q2', file: 'b.pdf', folder: 'x' },
    { id: 's3', publisher: 'CBRE', sector: 'industrial', period: '2026Q1', file: 'c.pdf', folder: 'y' },
    { id: 's4', publisher: 'Colliers (national snapshot)', sector: 'office+industrial', period: '2026Q2', file: 'n.pdf', folder: 'z' },
  ],
  obs: [
    obs('Capital Group', 'industrial', '2026Q1', 'Winnipeg', '', 'vacancy_rate', 4.5),
    obs('Capital Group', 'industrial', '2026Q2', 'Winnipeg', '', 'vacancy_rate', 5.4),
    obs('Capital Group', 'industrial', '2026Q2', 'Winnipeg', '', 'vacancy_rate', 4.5, 'prev_q'),
    obs('Capital Group', 'industrial', '2026Q2', 'Northwest', '', 'vacancy_rate', 7.2),
    obs('CBRE', 'industrial', '2026Q1', 'Winnipeg', '', 'availability_rate', 3.1, 'headline|ocr'),
    obs('Colliers', 'office', '2026Q2', 'Winnipeg', 'All', 'vacancy_rate', 13.6),
    obs('Colliers', 'office', '2026Q2', 'Downtown', 'Class A', 'vacancy_rate', 12.8),
    obs('CBRE Hotels', 'hotel', '2025', 'Winnipeg', '', 'occupancy', 70),
    obs('CBRE Hotels', 'hotel', '2026', 'Winnipeg', '', 'occupancy', 69, 'forecast|edition=2025Q3'),
  ],
  metrics: { vacancy_rate: { label: 'Vacancy rate', unit: 'pct' } },
  definitions: { CBRE: 'availability' },
  missing: [{ publisher: 'CBRE', sector: 'industrial', period: '2026Q2', reason: 'no file' },
            { publisher: 'CBRE', sector: 'industrial', period: '2026Q3', reason: 'not published' }],
  qc: [],
};

describe('brokerage-data', () => {
  const idx = seriesIndex(data);

  it('indexes actuals and leaves prior-quarter restatements out', () => {
    const s = idx.get('Capital Group|industrial|Winnipeg||vacancy_rate|');
    expect(s.points.map(p => p.value)).toEqual([4.5, 5.4]);
    expect([...idx.keys()].some(k => k.includes('prev_q'))).toBe(false);
  });

  it('keeps a forecast as its own variant keyed by edition', () => {
    expect(isForecast('forecast|edition=2025Q3')).toBe(true);
    expect(idx.get('CBRE Hotels|hotel|Winnipeg||occupancy|forecast:2025Q3').points[0].value).toBe(69);
    expect(idx.get('CBRE Hotels|hotel|Winnipeg||occupancy|').points[0].value).toBe(70);
  });

  it('lists publishers per sector in display order and their areas totals-first', () => {
    expect(publishersFor(idx, 'industrial')).toEqual(['Capital Group', 'CBRE']);
    expect(areasFor(idx, 'industrial', 'Capital Group').map(a => a.label)).toEqual(['Winnipeg (total)', 'Northwest']);
    expect(areasFor(idx, 'office', 'Colliers').map(a => a.label)).toEqual(['Winnipeg (total)', 'Downtown Class A']);
    expect(areaLabel('Winnipeg', 'All')).toBe('Winnipeg (total)');
  });

  it('builds the publishers-compared lines from each firm\'s market total', () => {
    expect(totalLines(idx, 'industrial')).toEqual([
      { publisher: 'Capital Group', geo: 'Winnipeg', segment: '' },
      { publisher: 'CBRE', geo: 'Winnipeg', segment: '' },
    ]);
    expect(totalLines(idx, 'office')).toEqual([{ publisher: 'Colliers', geo: 'Winnipeg', segment: 'All' }]);
  });

  it('makes card input with one series per line and names the caveats drawn', () => {
    const lines = totalLines(idx, 'industrial').map(l => ({ ...l, label: l.publisher }));
    const v = cardInput('c', idx, 'industrial', 'vacancy_rate', lines, {});
    expect(v.records).toHaveLength(2);
    expect(v.seriesMeta.map(s => s.chartLabel)).toEqual(['Capital Group']);
    expect(v.seriesMeta[0].units).toBe('percent');
    const a = cardInput('c', idx, 'industrial', 'availability_rate', lines, {});
    expect(a.flags).toEqual(['headline', 'ocr']);
    const h = cardInput('h', idx, 'hotel', 'occupancy', [{ publisher: 'CBRE Hotels', geo: 'Winnipeg', segment: '' }], {}, { forecasts: true });
    expect(h.seriesMeta).toHaveLength(2);
    expect(h.dashedIds).toHaveLength(1);
    expect(h.seriesMeta[1].chartLabel).toContain('forecast, 2025Q3 edition');
  });

  it('applies a from-year range', () => {
    const lines = [{ publisher: 'Capital Group', geo: 'Winnipeg', segment: '' }];
    expect(cardInput('c', idx, 'industrial', 'vacancy_rate', lines, { from: 2027 }).records).toHaveLength(0);
  });

  it('tabulates the latest periods newest first with ** for unpublished cells', () => {
    const lines = [{ publisher: 'Capital Group', geo: 'Winnipeg', segment: '', label: 'CG' },
                   { publisher: 'CBRE', geo: 'Winnipeg', segment: '', label: 'CBRE' }];
    const t = latestTable(idx, 'industrial', 'vacancy_rate', lines, 6);
    expect(t.periods).toEqual(['2026Q2', '2026Q1']);
    expect(t.rows[0].values).toEqual([5.4, 4.5]);
    expect(t.rows).toHaveLength(1);   // CBRE prints no vacancy_rate
    expect(fmtValue(null, 'pct')).toBe('**');
    expect(fmtValue(5.4, 'pct')).toBe('5.4%');
    expect(fmtValue(12.5, 'psf')).toBe('$12.50');
    expect(fmtValue(82600000, 'sf')).toBe('82,600,000');
  });

  it('reports coverage per publisher with the missing quarters, splitting a combined sector', () => {
    const c = coverage(data);
    const cg = c.find(r => r.publisher === 'Capital Group');
    expect(cg).toMatchObject({ sector: 'industrial', editions: 2, first: '2026Q1', last: '2026Q2', missing: [] });
    expect(c.find(r => r.publisher === 'CBRE').missing).toEqual(['2026Q2']);
    expect(c.find(r => r.publisher === 'CBRE').unpublished).toEqual(['2026Q3']);
    expect(c.filter(r => r.publisher === 'Colliers (national snapshot)').map(r => r.sector).sort()).toEqual(['industrial', 'office']);
  });

  it('labels periods and units', () => {
    expect(periodLabel('2026Q2')).toBe('Q2 2026');
    expect(periodLabel('2025')).toBe('2025');
    expect(unitOfMetric('asking_net_rent_psf')).toBe('psf');
    expect(unitOfMetric('absorption_sf')).toBe('sf');
    expect(years(idx)).toEqual([2025, 2026]);
  });
});
