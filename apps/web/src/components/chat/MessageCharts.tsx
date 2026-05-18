import React from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { AgentChart } from "../../hooks/useChat";

interface MessageChartsProps {
  charts: AgentChart[];
}

export default function MessageCharts({ charts }: MessageChartsProps) {
  if (!charts || charts.length === 0) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, marginTop: 12, marginBottom: 12 }}>
      {charts.map((chart, idx) => {
        // Merge multiple series into a single data array for Recharts
        // Structure: { x: string, [seriesName]: number }
        const mergedDataMap: Record<string, any> = {};
        chart.series.forEach((s) => {
          s.data.forEach((point) => {
            if (!mergedDataMap[point.x]) {
              mergedDataMap[point.x] = { x: point.x };
            }
            mergedDataMap[point.x][s.name] = point.y;
          });
        });

        const mergedData = Object.values(mergedDataMap).sort(
          (a, b) => new Date(a.x).getTime() - new Date(b.x).getTime()
        );

        if (mergedData.length === 0) {
          return (
            <div key={idx} style={{ padding: 20, textAlign: "center", border: "1px dashed var(--border)", borderRadius: 12 }}>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>No trend data to display for {chart.title}</span>
            </div>
          );
        }

        return (
          <div
            key={idx}
            style={{
              background: "var(--surface-1)",
              border: "1px solid var(--border)",
              borderRadius: 12,
              padding: "16px 12px",
              boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
              animation: "rvl-fadein 0.4s ease both",
              animationDelay: `${idx * 0.1}s`,
            }}
          >
            <div style={{ marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h4 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{chart.title}</h4>
              {chart.unit && (
                <span style={{ fontSize: 11, color: "var(--text-muted)", background: "var(--surface-2)", padding: "2px 8px", borderRadius: 4 }}>
                  Unit: {chart.unit}
                </span>
              )}
            </div>

            <div style={{ width: "100%", height: 220 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={mergedData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis
                    dataKey="x"
                    stroke="var(--text-muted)"
                    fontSize={10}
                    tickFormatter={(val) => {
                      try {
                        const d = new Date(val);
                        return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                      } catch {
                        return val;
                      }
                    }}
                    minTickGap={30}
                  />
                  <YAxis
                    stroke="var(--text-muted)"
                    fontSize={10}
                    tickFormatter={(val) => val.toLocaleString()}
                    domain={["auto", "auto"]}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "var(--surface-2)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      fontSize: 12,
                      color: "var(--text)",
                    }}
                    itemStyle={{ padding: "2px 0" }}
                    labelStyle={{ marginBottom: 4, fontWeight: 600 }}
                    labelFormatter={(label) => new Date(label).toLocaleString()}
                  />
                  {chart.series.length > 1 && <Legend wrapperStyle={{ fontSize: 11, paddingTop: 10 }} />}
                  
                  {chart.series.map((s, sIdx) => (
                    <Line
                      key={sIdx}
                      type="monotone"
                      dataKey={s.name}
                      stroke={sIdx === 0 ? "var(--accent)" : sIdx === 1 ? "#22c55e" : "#f59e0b"}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4, strokeWidth: 0 }}
                      animationDuration={1000}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        );
      })}
    </div>
  );
}
