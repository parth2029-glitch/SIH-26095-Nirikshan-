import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import L from 'leaflet';
import { Failed, Loading, Panel, useApi } from './ui.jsx';

/**
 * Institutes on a map, coloured by fraud signature.
 *
 * Leaflet directly rather than `react-leaflet`: this is one map with one layer,
 * and the wrapper's whole value is keeping React and Leaflet's own DOM in step
 * for components that mount and unmount. Two hundred circle markers built once
 * in an effect need none of that.
 *
 * `circleMarker`, not `marker` — a pin needs an image asset Vite has to be told
 * how to bundle, and a coloured dot carries the risk signature better anyway.
 */
const COLOUR = {
  GHOST_INTAKE: '#b3261e',
  THRESHOLD_GAMING: '#a15c00',
  EVIDENCE_REUSE: '#7a3ea1',
  PREPARED_VISIT: '#0a5ea1',
  INSPECTOR_CAPTURE: '#a1006b',
  CLEAN: '#0a7a41',
};

export default function RiskMap() {
  const { loading, data, error } = useApi('/api/dashboard/institutes');
  const container = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!data || !container.current) return;
    const map = L.map(container.current, { scrollWheelZoom: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 18,
    }).addTo(map);

    const points = [];
    for (const institute of data.institutes) {
      const [lng, lat] = institute.coordinates;
      points.push([lat, lng]);
      L.circleMarker([lat, lng], {
        radius: 5 + Math.round(institute.riskScore / 25),
        color: COLOUR[institute.riskSignature] ?? COLOUR.CLEAN,
        weight: 1.5,
        fillOpacity: 0.55,
      })
        .bindTooltip(
          `<strong>${institute.name}</strong><br>${institute.district} · ${institute.riskSignature}<br>risk ${institute.riskScore}`,
        )
        .on('click', () => navigate(`/queue?institute=${institute.id}`))
        .addTo(map);
    }
    // Fit to what is actually in scope: a DISTRICT token sees one district, and
    // a hard-coded state-wide view would open on mostly empty map.
    if (points.length) map.fitBounds(points, { padding: [30, 30] });
    else map.setView([19.7515, 75.7139], 6);

    return () => map.remove();
  }, [data, navigate]);

  if (loading) return <Loading what="the map" />;
  if (error) return <Failed error={error} />;

  return (
    <Panel
      title="Risk map"
      note={`${data.institutes.length} institutes, coloured by fraud signature`}
      actions={
        <ul className="flex flex-wrap gap-3 text-xs text-dim">
          {Object.entries(COLOUR).map(([signature, colour]) => (
            <li key={signature} className="flex items-center gap-1">
              <span
                className="inline-block size-2.5 rounded-full"
                style={{ backgroundColor: colour }}
              />
              {signature.replace(/_/g, ' ').toLowerCase()}
            </li>
          ))}
        </ul>
      }
    >
      <div ref={container} className="h-[70vh] rounded border border-line" />
    </Panel>
  );
}
