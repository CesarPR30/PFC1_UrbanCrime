import React, { useMemo } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell,
} from "recharts";
import type { CrimeRecord } from "../hooks/useCrimeData";
import { crimeColor, crimeLabel } from "../theme";

interface Props { data: CrimeRecord[] }

const CrimeTypePanel: React.FC<Props> = ({ data }) => {
  const byType = useMemo(() => {
    const map: Record<string, number> = {};
    data.forEach((d) => { map[d.type] = (map[d.type] ?? 0) + 1; });
    return Object.entries(map)
      .map(([type, total]) => ({ tipo: type, label: crimeLabel(type), total }))
      .sort((a, b) => b.total - a.total);
  }, [data]);

  return (
    <div className="crime-type-panel">
      <div className="crime-type-panel__header">
        <span className="crime-type-panel__title">Tipos de delito</span>
        <span className="crime-type-panel__subtitle">{data.length} registros</span>
      </div>

      <div className="crime-type-panel__section">
        <div className="crime-type-panel__section-label">Por tipo</div>
        <ResponsiveContainer width="100%" height={byType.length * 36 + 8}>
          <BarChart data={byType} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" horizontal={false} />
            <XAxis type="number" tick={{ fontSize: 10, fill: "#6b7280" }} axisLine={false} tickLine={false} />
            <YAxis
              dataKey="label"
              type="category"
              tick={{ fontSize: 10, fill: "#374151" }}
              width={72}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e5e7eb" }}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              formatter={(v: any, _n: any, p: any) => [v, p.payload?.label]}
            />
            <Bar dataKey="total" name="Total" radius={[0, 6, 6, 0]} maxBarSize={22}>
              {byType.map((entry) => (
                <Cell key={entry.tipo} fill={crimeColor(entry.tipo)} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

export default CrimeTypePanel;
