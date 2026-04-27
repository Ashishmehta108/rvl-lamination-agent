import useSWR from "swr";
import { api } from "../lib/api";
import { useEffect, useRef, useState } from "react";

export interface TagLatest {
  machineId: string;
  tagId: string;
  slug?: string;
  name?: string;
  ts: string;
  valueNumber?: number | null;
  valueBool?: boolean | null;
  valueString?: string | null;
  quality?: string;
}

export interface Alert {
  id: string;
  severity: "critical" | "warning" | "info";
  status: string;
  title: string;
  startsAt: string;
}

export interface ReportRun {
  id: string;
  status: string;
  createdAt: string;
  windowStart?: string;
  windowEnd?: string;
  metrics?: any;
}

export function useDashboard(machineId: string) {
  const [history, setHistory] = useState<any[]>([]);
  const historyRef = useRef<any[]>([]);

  const { data: tagsData, error: tagsError, mutate: mutateTags } = useSWR(
    [`/tags/latest`, machineId],
    () => api.get<{ items: TagLatest[] }>(`/tags/latest`, { machineId }),
    { refreshInterval: 2000 }
  );

  // Accumulate history when new tags arrive
  useEffect(() => {
    if (tagsData?.items) {
      const point: any = { t: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) };
      tagsData.items.forEach((item) => {
        if (typeof item.valueNumber === 'number') {
          // Use slug if available for easier mapping in components, fallback to tagId
          const key = item.slug || item.tagId;
          point[key] = item.valueNumber;
        }
      });

      const newHistory = [...historyRef.current, point].slice(-40);
      historyRef.current = newHistory;
      setHistory(newHistory);
    }
  }, [tagsData]);

  const { data: alertsData, error: alertsError } = useSWR(
    [`/alerts`, machineId],
    () => api.get<{ items: Alert[] }>(`/alerts`, { machineId, status: "open" }),
    { refreshInterval: 5000 }
  );

  const { data: reportsData, error: reportsError, mutate: mutateReports } = useSWR(
    [`/reports/runs`, machineId, "8"],
    () => api.get<{ items: ReportRun[] }>(`/reports/runs`, { machineId, limit: "8" }),
    { refreshInterval: 10000 }
  );

  return {
    items: tagsData?.items ?? [],
    alerts: alertsData?.items ?? [],
    reports: reportsData?.items ?? [],
    history,
    isLoading: !tagsData && !tagsError,
    isError: !!(tagsError || alertsError || reportsError),
    mutateTags,
    mutateReports
  };
}
