import { useEffect, useMemo, useRef, useState } from "react";

const HEIGHT = 190;
const PAD = { top: 12, right: 12, bottom: 26, left: 40 };

function formatTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Temperature over time: one 2px line, recessive grid, crosshair + tooltip on hover, table view. */
export default function TempChart({ points }) {
  const wrapRef = useRef(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState(null);
  const [showTable, setShowTable] = useState(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(280, entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const geo = useMemo(() => {
    if (points.length < 2) return null;
    const t0 = points[0].t;
    const t1 = points[points.length - 1].t;
    let lo = Math.min(...points.map((p) => p.v));
    let hi = Math.max(...points.map((p) => p.v));
    lo = Math.floor(lo - 1);
    hi = Math.ceil(hi + 1);
    const innerW = width - PAD.left - PAD.right;
    const innerH = HEIGHT - PAD.top - PAD.bottom;
    const x = (t) => PAD.left + ((t - t0) / Math.max(1, t1 - t0)) * innerW;
    const y = (v) => PAD.top + (1 - (v - lo) / (hi - lo)) * innerH;
    const step = hi - lo > 8 ? 2 : 1;
    const ticks = [];
    for (let v = lo; v <= hi; v += step) ticks.push(v);
    const path = points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
    const area = `${path}L${x(t1).toFixed(1)},${PAD.top + innerH}L${x(t0).toFixed(1)},${PAD.top + innerH}Z`;
    return { x, y, ticks, path, area, t0, t1, innerH };
  }, [points, width]);

  function onMove(e) {
    if (!geo) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    let best = points[0];
    let bestD = Infinity;
    for (const p of points) {
      const d = Math.abs(geo.x(p.t) - px);
      if (d < bestD) { bestD = d; best = p; }
    }
    setHover(best);
  }

  return (
    <div className="chart">
      <div className="chart-head">
        <h2>Temperature</h2>
        <button type="button" className="link-btn" onClick={() => setShowTable((s) => !s)}>
          {showTable ? "Show chart" : "Show table"}
        </button>
      </div>
      <div ref={wrapRef} className="chart-body">
        {!geo && <div className="empty">Waiting for temperature readings…</div>}
        {geo && !showTable && (
          <>
            <svg width={width} height={HEIGHT} role="img" aria-label="Room temperature over time"
                 onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
              {geo.ticks.map((v) => (
                <g key={v}>
                  <line x1={PAD.left} x2={width - PAD.right} y1={geo.y(v)} y2={geo.y(v)} className="gridline" />
                  <text x={PAD.left - 8} y={geo.y(v) + 4} className="axis" textAnchor="end">{v}°</text>
                </g>
              ))}
              <text x={PAD.left} y={HEIGHT - 6} className="axis">{formatTime(geo.t0)}</text>
              <text x={width - PAD.right} y={HEIGHT - 6} className="axis" textAnchor="end">{formatTime(geo.t1)}</text>
              <path d={geo.area} className="area" />
              <path d={geo.path} className="line" />
              {hover && (
                <g>
                  <line x1={geo.x(hover.t)} x2={geo.x(hover.t)} y1={PAD.top} y2={PAD.top + geo.innerH} className="crosshair" />
                  <circle cx={geo.x(hover.t)} cy={geo.y(hover.v)} r="5" className="dot" />
                </g>
              )}
              <rect x={PAD.left} y={PAD.top} width={width - PAD.left - PAD.right} height={geo.innerH} fill="transparent" />
            </svg>
            {hover && (
              <div className="tooltip" style={{ left: Math.min(geo.x(hover.t) + 12, width - 150), top: 8 }}>
                <div className="tooltip-time">{formatTime(hover.t)}</div>
                <div><b>{hover.v.toFixed(1)} °C</b></div>
                {typeof hover.occ === "number" && <div className="muted">{hover.occ} inside</div>}
              </div>
            )}
          </>
        )}
        {geo && showTable && (
          <table className="data-table">
            <thead><tr><th>Time</th><th>Temperature</th><th>People inside</th></tr></thead>
            <tbody>
              {[...points].reverse().slice(0, 12).map((p, i) => (
                <tr key={i}><td>{formatTime(p.t)}</td><td>{p.v.toFixed(1)} °C</td><td>{p.occ ?? "–"}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
