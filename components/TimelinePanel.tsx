import React, { useRef, useEffect, useState, useMemo, useCallback } from "react";
import * as d3 from "d3";
import type { CrimeRecord } from "../hooks/useCrimeData";

const MONTH_ABBR = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
const COLOR = "#FE550B";

interface MonthBucket {
  key: string;
  month: number;
  year: number;
  label: string;
  total: number;
}

/** A subgraph to flag on the timeline at the month it belongs to. */
export interface TimelineMarker {
  month: string; // "YYYY-MM" (1-based month, as in the hotspots data)
  rank: number;
  kind: "selected" | "similar";
}

interface Props {
  data: CrimeRecord[];
  onFilter: (filtered: CrimeRecord[]) => void;
  /** Subgraphs to mark on the axis (selected + its similar ones). */
  markers?: TimelineMarker[];
}

const M = { top: 10, right: 16, bottom: 26, left: 36 };

const TimelinePanel: React.FC<Props> = ({ data, onFilter, markers = [] }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const brushRef = useRef<d3.BrushBehavior<unknown> | null>(null);
  const brushGRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  // Kept so the markers effect can position flags without rebuilding the chart
  // (rebuilding would tear down an active brush filter).
  const xScaleRef = useRef<d3.ScalePoint<string> | null>(null);
  const iHRef = useRef(0);
  const markersGRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const [hasFilter, setHasFilter] = useState(false);
  const [filterLabel, setFilterLabel] = useState("");

  const onFilterRef = useRef(onFilter);
  onFilterRef.current = onFilter;
  const dataRef = useRef(data);
  dataRef.current = data;

  const buckets = useMemo<MonthBucket[]>(() => {
    const map = new Map<string, number>();
    data.forEach(d => {
      const dt = new Date(d.date);
      if (isNaN(dt.getTime())) return;
      const y = dt.getFullYear();
      const m = dt.getMonth();
      const key = `${y}-${String(m).padStart(2, "0")}`;
      map.set(key, (map.get(key) ?? 0) + 1);
    });
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, total]) => {
        const [ys, ms] = key.split("-");
        const month = parseInt(ms);
        return { key, year: parseInt(ys), month, label: MONTH_ABBR[month], total };
      });
  }, [data]);

  const multiYear = useMemo(
    () => new Set(buckets.map(b => b.year)).size > 1,
    [buckets]
  );

  const clearFilter = useCallback(() => {
    if (brushRef.current && brushGRef.current) {
      brushGRef.current.call(brushRef.current.move, null);
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    const svgEl = svgRef.current;
    if (!container || !svgEl || buckets.length === 0) return;

    const W = container.clientWidth;
    const H = container.clientHeight;
    const iW = W - M.left - M.right;
    const iH = H - M.top - M.bottom;
    if (iW <= 0 || iH <= 0) return;

    const svg = d3.select(svgEl);
    svg.selectAll("*").remove();
    svg.attr("width", W).attr("height", H);

    const g = svg.append("g").attr("transform", `translate(${M.left},${M.top})`);

    // Scales
    const x = d3.scalePoint<string>()
      .domain(buckets.map(b => b.key))
      .range([0, iW])
      .padding(0.5);

    const maxVal = d3.max(buckets, b => b.total) ?? 1;
    const y = d3.scaleLinear()
      .domain([0, maxVal * 1.15])
      .range([iH, 0])
      .nice();

    // Horizontal grid
    g.append("g")
      .call(d3.axisLeft(y).ticks(3).tickSize(-iW).tickFormat(() => ""))
      .call(ax => ax.select(".domain").remove())
      .call(ax => ax.selectAll(".tick line")
        .attr("stroke", "#f0f0f0")
        .attr("stroke-dasharray", "3,2"));

    // Path generators
    const areaFn = d3.area<MonthBucket>()
      .x(d => x(d.key)!)
      .y0(iH)
      .y1(d => y(d.total))
      .curve(d3.curveMonotoneX);

    const lineFn = d3.line<MonthBucket>()
      .x(d => x(d.key)!)
      .y(d => y(d.total))
      .curve(d3.curveMonotoneX);

    // Selection highlight rect (drawn behind data layers)
    const selRect = g.append("rect")
      .attr("y", 0).attr("height", iH)
      .attr("x", 0).attr("width", 0)
      .attr("fill", `${COLOR}18`).attr("rx", 2);

    // Area fill
    const areaPath = g.append("path")
      .datum(buckets)
      .attr("d", areaFn)
      .attr("fill", `${COLOR}22`)
      .attr("stroke", "none");

    // Line stroke
    const linePath = g.append("path")
      .datum(buckets)
      .attr("d", lineFn)
      .attr("fill", "none")
      .attr("stroke", COLOR)
      .attr("stroke-width", 2)
      .attr("stroke-linejoin", "round");

    // Dots
    const dots = g.selectAll<SVGCircleElement, MonthBucket>(".dot")
      .data(buckets)
      .join("circle")
      .attr("class", "dot")
      .attr("cx", d => x(d.key)!)
      .attr("cy", d => y(d.total))
      .attr("r", 3)
      .attr("fill", COLOR)
      .attr("stroke", "#fff")
      .attr("stroke-width", 1.5);

    dots.append("title")
      .text(d => `${d.label} ${d.year}: ${d.total.toLocaleString()}`);

    // Group for subgraph month markers; populated by a separate effect so it
    // survives selection changes without rebuilding (and resetting) the brush.
    // pointer-events: none keeps the brush drag working through the markers.
    const markersG = g.append("g")
      .attr("class", "markers")
      .attr("pointer-events", "none");
    markersGRef.current = markersG;
    xScaleRef.current = x;
    iHRef.current = iH;

    // X axis
    g.append("g")
      .attr("transform", `translate(0,${iH})`)
      .call(d3.axisBottom(x).tickFormat(key => {
        const b = buckets.find(b => b.key === key);
        if (!b) return "";
        if (multiYear && b.month === 0) return `${b.label}'${String(b.year).slice(2)}`;
        return b.label;
      }))
      .call(ax => ax.select(".domain").remove())
      .call(ax => ax.selectAll(".tick line").remove())
      .call(ax => ax.selectAll<SVGTextElement, unknown>("text")
        .attr("font-size", 10)
        .attr("fill", "#9ca3af"));

    // Y axis
    g.append("g")
      .call(d3.axisLeft(y).ticks(3).tickFormat(v => d3.format("~s")(v as number)))
      .call(ax => ax.select(".domain").remove())
      .call(ax => ax.selectAll(".tick line").remove())
      .call(ax => ax.selectAll<SVGTextElement, unknown>("text")
        .attr("font-size", 10)
        .attr("fill", "#9ca3af"));

    // Brush — updates rect visually on drag, filters on end
    const brush = d3.brushX()
      .extent([[0, 0], [iW, iH]])
      .on("brush", event => {
        const sel = event.selection as [number, number] | null;
        if (!sel) return;
        const [x0, x1] = sel;
        selRect.attr("x", x0).attr("width", x1 - x0);
        areaPath.attr("fill", `${COLOR}0A`);
        linePath.attr("opacity", 0.18);
        const chosen = new Set(
          buckets.filter(b => { const px = x(b.key)!; return px >= x0 && px <= x1; })
                 .map(b => b.key)
        );
        dots.attr("opacity", d => chosen.has(d.key) ? 1 : 0.15)
            .attr("r", d => chosen.has(d.key) ? 4 : 2.5);
      })
      .on("end", event => {
        const sel = event.selection as [number, number] | null;

        if (!sel) {
          selRect.attr("width", 0);
          areaPath.attr("fill", `${COLOR}22`);
          linePath.attr("opacity", 1);
          dots.attr("opacity", 1).attr("r", 3);
          setHasFilter(false);
          setFilterLabel("");
          onFilterRef.current(dataRef.current);
          return;
        }

        const [x0, x1] = sel;
        const chosen = buckets.filter(b => { const px = x(b.key)!; return px >= x0 && px <= x1; });

        if (chosen.length === 0) {
          selRect.attr("width", 0);
          areaPath.attr("fill", `${COLOR}22`);
          linePath.attr("opacity", 1);
          dots.attr("opacity", 1).attr("r", 3);
          setHasFilter(false);
          setFilterLabel("");
          onFilterRef.current(dataRef.current);
          return;
        }

        const first = chosen[0];
        const last = chosen[chosen.length - 1];
        const lbl = first.key === last.key
          ? `${first.label} ${first.year}`
          : first.year === last.year
            ? `${first.label} – ${last.label} ${first.year}`
            : `${first.label} ${first.year} – ${last.label} ${last.year}`;

        setHasFilter(true);
        setFilterLabel(lbl);

        const chosenKeys = new Set(chosen.map(b => b.key));
        const filtered = dataRef.current.filter(d => {
          const dt = new Date(d.date);
          if (isNaN(dt.getTime())) return false;
          const key = `${dt.getFullYear()}-${String(dt.getMonth()).padStart(2, "0")}`;
          return chosenKeys.has(key);
        });
        onFilterRef.current(filtered);
      });

    brushRef.current = brush;
    const brushG = g.append("g").call(brush);
    brushGRef.current = brushG;

    // Hide default D3 brush rect (we draw our own selRect)
    brushG.select(".selection").attr("fill", "none").attr("stroke", "none");
    brushG.selectAll(".handle").remove();

  }, [buckets, multiYear]);

  // Draw the subgraph month markers. Runs on its own (also after the main
  // effect rebuilds, since `buckets` is a dep) so a live brush isn't disturbed.
  useEffect(() => {
    const g = markersGRef.current;
    const x = xScaleRef.current;
    const iH = iHRef.current;
    if (!g || !x) return;

    // Hotspot months are "YYYY-MM" (1-based); timeline bucket keys use a
    // 0-based month, so shift by one to line them up.
    const toBucketKey = (m: string) => {
      const [y, mo] = m.split("-");
      return `${y}-${String(parseInt(mo) - 1).padStart(2, "0")}`;
    };

    const sel = g.selectAll<SVGGElement, TimelineMarker>("g.marker")
      .data(markers.filter(mk => x(toBucketKey(mk.month)) != null), mk => `${mk.month}|${mk.rank}`);
    sel.exit().remove();

    const enter = sel.enter().append("g").attr("class", "marker");
    enter.append("line");
    enter.append("circle");

    const merged = enter.merge(sel);
    merged.attr("transform", mk => `translate(${x(toBucketKey(mk.month))},0)`);
    merged.select("line")
      .attr("x1", 0).attr("x2", 0).attr("y1", 0).attr("y2", iH)
      .attr("stroke", mk => (mk.kind === "selected" ? "#FE550B" : "#0D9488"))
      .attr("stroke-width", mk => (mk.kind === "selected" ? 2 : 1))
      .attr("stroke-dasharray", mk => (mk.kind === "selected" ? "none" : "3 2"))
      .attr("opacity", mk => (mk.kind === "selected" ? 0.85 : 0.5));
    merged.select("circle")
      .attr("cx", 0).attr("cy", 0)
      .attr("r", mk => (mk.kind === "selected" ? 4 : 3))
      .attr("fill", mk => (mk.kind === "selected" ? "#FE550B" : "#0D9488"))
      .attr("stroke", "#fff").attr("stroke-width", 1.2);
  }, [markers, buckets]);

  return (
    <div className="timeline-panel">
      <div className="timeline-panel__header">
        <span className="timeline-panel__title">Línea de tiempo · Delitos por mes</span>
        {hasFilter ? (
          <span className="timeline-panel__filter-badge">
            {filterLabel}
            <button className="timeline-panel__clear-btn" onClick={clearFilter} title="Limpiar filtro">
              ×
            </button>
          </span>
        ) : (
          <span className="timeline-panel__subtitle">
            {data.length.toLocaleString()} registros · arrastra para filtrar
          </span>
        )}
      </div>
      <div className="timeline-panel__chart" ref={containerRef}>
        <svg ref={svgRef} style={{ display: "block" }} />
      </div>
    </div>
  );
};

export default TimelinePanel;
